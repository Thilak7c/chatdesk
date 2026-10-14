import { NextResponse, after } from 'next/server'
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'

import { db } from '@/db'
import {
  broadcastRecipients,
  broadcasts,
  conversations,
  messageReactions,
  messages,
  whatsappConfig,
} from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia, objectStoreMirror } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/contacts/find-or-create'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { updateRecipient } from '@/lib/broadcasts/counters'
import { emitReactionEvent, publishConversation, publishMessage } from '@/lib/socket'
import { siteUrlFrom } from '@/lib/site-url'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default. Tune as needed.
export const maxDuration = 60

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /**
   * Set when the customer taps a QUICK_REPLY button on a *template*
   * message — a broadcast, or any template send. Meta uses a different
   * envelope from `interactive` above: `type: 'button'`, the label in
   * `button.text`, and the payload configured on the template's button
   * in `button.payload` (Meta's own template editor doesn't ask for a
   * payload and mirrors the label into it).
   */
  button?: { text?: string; payload?: string }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Check every config's verify token. Also collect the matching row
    // so we can opportunistically upgrade its token to GCM if it was
    // still in the legacy CBC format.
    const configs = await db
      .select({ id: whatsappConfig.id, verifyToken: whatsappConfig.verifyToken })
      .from(whatsappConfig)

    let matchedConfig: { id: string; verifyToken: string | null } | null = null
    for (const config of configs) {
      if (!config.verifyToken) continue
      try {
        if (decrypt(config.verifyToken) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (matchedConfig.verifyToken && isLegacyFormat(matchedConfig.verifyToken)) {
        db.update(whatsappConfig)
          .set({ verifyToken: encrypt(verifyToken) })
          .where(eq(whatsappConfig.id, matchedConfig.id))
          .catch((error: Error) => {
            console.warn('[webhook] verify_token GCM upgrade failed:', error.message)
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Public base URL for mirrored media. Meta calls us with our own Host,
  // so this resolves even without NEXT_PUBLIC_SITE_URL; if it can't be
  // derived, mirroring is skipped and the proxy URL is stored instead.
  let mediaBaseUrl: string | null = null
  try {
    mediaBaseUrl = siteUrlFrom(request)
  } catch {
    mediaBaseUrl = null
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (where this app used to run) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it.
  // `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body, mediaBaseUrl)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(
  body: { entry?: WhatsAppWebhookEntry[] },
  mediaBaseUrl: string | null
) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          db,
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // The account that owns this number. phone_number_id is UNIQUE, so
      // this is at most one row.
      const [config] = await db
        .select()
        .from(whatsappConfig)
        .where(eq(whatsappConfig.phoneNumberId, phoneNumberId))
        .limit(1)

      if (!config) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      const decryptedAccessToken = decrypt(config.accessToken)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.accountId,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.userId,
          decryptedAccessToken,
          config.mirrorInboundMedia && mediaBaseUrl ? mediaBaseUrl : null
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages. Meta's status values already match the
  //    CHECK constraint on messages.status. message_id (the wamid) is
  //    not unique across numbers, so this updates 0..N rows. Only known
  //    statuses are written so an unexpected value can't trip the CHECK.
  const KNOWN_MESSAGE_STATUSES = ['sent', 'delivered', 'read', 'failed']
  if (KNOWN_MESSAGE_STATUSES.includes(status.status)) {
    try {
      const updated = await db
        .update(messages)
        .set({ status: status.status })
        .where(eq(messages.messageId, status.id))
        .returning()
      for (const row of updated) {
        const [conv] = await db
          .select({ accountId: conversations.accountId })
          .from(conversations)
          .where(eq(conversations.id, row.conversationId))
          .limit(1)
        if (conv) publishMessage(conv.accountId, 'UPDATE', row)
      }
    } catch (msgErr) {
      console.error('Error updating message status:', msgErr)
    }
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id.
  //    updateRecipient() adjusts the parent broadcast's counters in the
  //    same transaction.
  const ts = new Date(parseInt(status.timestamp) * 1000)
  try {
    const [recipient] = await db
      .select({ id: broadcastRecipients.id, status: broadcastRecipients.status })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.whatsappMessageId, status.id))
      .limit(1)

    if (
      recipient &&
      // Guard transitions — forward-only on the success ladder, and
      // `failed` only from pre-delivered states.
      isValidStatusTransition(recipient.status, status.status)
    ) {
      await updateRecipient(db, recipient.id, {
        status: status.status,
        ...(status.status === 'sent' ? { sentAt: ts } : {}),
        ...(status.status === 'delivered' ? { deliveredAt: ts } : {}),
        ...(status.status === 'read' ? { readAt: ts } : {}),
      })
    }
  } catch (recErr) {
    console.error('Error updating broadcast recipient status:', recErr)
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  const [msgRow] = await db
    .select({ conversationId: messages.conversationId, accountId: conversations.accountId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.messageId, status.id))
    .limit(1)

  if (msgRow) {
    await dispatchWebhookEvent(db, msgRow.accountId, 'message.status_updated', {
      whatsapp_message_id: status.id,
      conversation_id: msgRow.conversationId,
      status: status.status,
    })
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const [row] = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
      .where(
        and(
          eq(broadcastRecipients.contactId, contactId),
          eq(broadcasts.accountId, accountId),
          inArray(broadcastRecipients.status, ['sent', 'delivered', 'read'])
        )
      )
      .orderBy(desc(broadcastRecipients.createdAt))
      .limit(1)

    if (!row) return

    await updateRecipient(db, row.id, { status: 'replied', repliedAt: new Date() })
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.messageId, metaId), eq(messages.conversationId, conversationId)))
      .limit(1)
    return row?.id ?? null
  } catch (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', (error as Error).message)
    return null
  }
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  accountId: string,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  try {
    if (!reaction.emoji) {
      const removed = await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, targetInternalId),
            eq(messageReactions.actorType, 'customer'),
            eq(messageReactions.actorId, contactId)
          )
        )
        .returning({ id: messageReactions.id })
      for (const r of removed) {
        emitReactionEvent(accountId, { eventType: 'DELETE', new: null, old: { id: r.id } })
      }
      return
    }

    const [row] = await db
      .insert(messageReactions)
      .values({
        messageId: targetInternalId,
        conversationId,
        actorType: 'customer',
        actorId: contactId,
        emoji: reaction.emoji,
      })
      .onConflictDoUpdate({
        target: [messageReactions.messageId, messageReactions.actorType, messageReactions.actorId],
        set: { emoji: reaction.emoji },
      })
      .returning()
    if (row) emitReactionEvent(accountId, { eventType: 'UPSERT', new: toSnake(row) })
  } catch (error) {
    console.error('[webhook] reaction write failed:', (error as Error).message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  // Public base URL to mirror inbound media under, or null when the
  // account opted out of mirroring (or no base URL is known). See
  // parseMessageContent for what it turns off.
  mirrorBaseUrl: string | null
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Find or create the contact + conversation. The shared helper uses
  // the same fuzzy phone match as the contact form and CSV import, and
  // the unique indexes as the race backstop.
  let contactOutcome: Awaited<ReturnType<typeof findOrCreateContact>>
  let convResult: Awaited<ReturnType<typeof findOrCreateConversation>>
  try {
    contactOutcome = await findOrCreateContact(db, {
      accountId,
      auditUserId: configOwnerUserId,
      phone: senderPhone,
      name: contactName,
      // Keep WhatsApp profile names fresh on existing contacts.
      refreshName: true,
    })
    convResult = await findOrCreateConversation(db, {
      accountId,
      contactId: contactOutcome.contact.id,
      auditUserId: configOwnerUserId,
    })
  } catch (error) {
    console.error('Error resolving contact/conversation:', error)
    return
  }
  const contactRecord = contactOutcome.contact
  const conversation = convResult.conversation
  if (convResult.created) publishConversation(accountId, 'INSERT', conversation)

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, accountId, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(
      message,
      accessToken,
      mirrorBaseUrl ? { accountId, baseUrl: mirrorBaseUrl } : null
    )

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // The messages.content_type CHECK constraint allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'         // stickers are images
      : message.type === 'button'
        ? 'interactive' // template quick-reply tap
        : 'text'        // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const [prior] = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.senderType, 'customer')))
  const isFirstInboundMessage = (prior?.n ?? 0) === 0

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) makes a replay conflict;
  // ON CONFLICT DO NOTHING then returns no row, which is how we know this
  // delivery was a replay. This is the single idempotency boundary that
  // must sit BEFORE the unread bump and all downstream fan-out below.
  let inserted: typeof messages.$inferSelect | undefined
  try {
    ;[inserted] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        senderType: 'customer',
        contentType,
        contentText,
        mediaUrl,
        // Meta's MIME type for the attachment — lets the download path
        // pick an extension without fetching the bytes first.
        mediaType,
        messageId: message.id,
        status: 'delivered',
        createdAt: new Date(parseInt(message.timestamp) * 1000),
        replyToMessageId: replyToInternalId,
        // Only populated for content_type='interactive'.
        interactiveReplyId,
      })
      .onConflictDoNothing({ target: [messages.conversationId, messages.messageId] })
      .returning()
  } catch (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks.
  if (!inserted) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.id
    )
    return
  }

  publishMessage(accountId, 'INSERT', inserted)

  // Update conversation. The unread bump is an in-SQL increment rather
  // than a read-modify-write of the snapshot loaded above: two inbound
  // messages for the same conversation can process concurrently, and
  // computing `snapshot + 1` in the app let both write the same value,
  // losing one.
  try {
    await db
      .update(conversations)
      .set({
        unreadCount: sql`${conversations.unreadCount} + 1`,
        lastMessageText: contentText || `[${message.type}]`,
        lastMessageAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id))
  } catch (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread. Kept as a
  // separate conditional statement rather than a `status` field on the
  // update above so the write can be gated on the row's CURRENT status in
  // SQL — see the helper for why that matters.
  await reopenClosedConversation(db, conversation)

  const [freshConversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversation.id))
    .limit(1)
  if (freshConversation) publishConversation(accountId, 'UPDATE', freshConversation)

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances.
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.created) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run — automation runs that log
  // zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  // Tenancy + public base URL for the media mirror. Null disables
  // mirroring entirely, which is what the account-level toggle does.
  mirror: { accountId: string; baseUrl: string } | null
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  //
  // Beyond verifying, this is where inbound media gets COPIED into the
  // `chat-media` bucket. Meta deletes media ~30 days after
  // receipt, so the `/api/whatsapp/media/<id>` proxy URL we used to
  // store is a pointer with an expiry date on it — every inbound
  // attachment silently became "Photo unavailable" a month later.
  // Mirroring stores a durable public URL instead.
  //
  // The mirror is strictly best-effort. `mirrorInboundMedia` swallows
  // its own failures and returns null, and we fall back to the proxy
  // URL — a webhook that throws would have Meta retry the delivery and
  // re-run everything downstream, which is a far worse outcome than an
  // attachment that expires.
  const verifyAndBuildUrl = async (
    mediaId: string,
    fileName?: string | null
  ): Promise<string | null> => {
    try {
      const info = await getMediaUrl({ mediaId, accessToken })

      if (mirror) {
        const mirrored = await mirrorInboundMedia({
          storage: objectStoreMirror(mirror.baseUrl),
          accountId: mirror.accountId,
          mediaId,
          downloadUrl: info.url,
          accessToken,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
          fileName,
          messageTimestamp: message.timestamp,
        })
        if (mirrored) return mirrored
      }

      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          // The sender's own filename becomes the mirrored object's
          // name, so saving the attachment yields `invoice.pdf` even
          // when a caption displaced the filename in content_text.
          mediaUrl: await verifyAndBuildUrl(
            message.document.id,
            message.document.filename
          ),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    case 'button': {
      // Quick-reply tap on a TEMPLATE message. Meta delivers these under
      // their own `button` envelope rather than `interactive` above, so
      // without this case they fell through to `default` and landed in
      // the inbox as "[Unsupported message type: button]" with a null
      // interactiveReplyId — which also meant the Flows engine and the
      // `interactive_reply` automation trigger never saw the tap, so
      // nothing chained off a broadcast reply.
      //
      // `payload` is the stable value (the analogue of
      // `button_reply.id`); `text` is the visible label. Prefer the
      // payload for routing and the label for display, each falling
      // back to the other since a template may carry only one.
      const payload = message.button?.payload || null
      const label = message.button?.text || null
      return {
        ...empty,
        contentText: label || payload,
        interactiveReplyId: payload || label,
      }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}
