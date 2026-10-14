// ============================================================
// Bot-side send base — shared by the Flows engine, the automation
// engine and the AI auto-reply. Owns everything around the actual
// Meta call:
//
//   1. account-scoped contact + WhatsApp config lookup (an engine run
//      must never message another tenant's contact),
//   2. phone-variant retry, writing a working variant back to the
//      contact so the next send goes straight through,
//   3. persisting the message (sender_type 'bot') and bumping the
//      conversation preview,
//   4. publishing both to the account's realtime room.
//
// Callers supply only the Meta call itself (`send`) and what to
// persist (`record`).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { contacts, conversations, messages, whatsappConfig } from '@/db/schema'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { publishConversation, publishMessage } from '@/lib/socket'

export interface EngineTarget {
  /** Tenancy key — drives the contact + whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
}

export interface MetaSendContext {
  phoneNumberId: string
  accessToken: string
  /** Recipient phone (one of the variants being tried). */
  to: string
}

export interface EngineMessageRecord {
  contentType: string
  contentText: string | null
  templateName?: string | null
  interactivePayload?: unknown
  aiGenerated?: boolean
  /** Conversation-list preview; defaults to contentText or `[contentType]`. */
  preview?: string
}

export interface EngineSendResult {
  /** Meta's wamid. */
  whatsapp_message_id: string
  /** Our messages.id for the persisted row. */
  message_id: string
}

export async function engineSend(
  target: EngineTarget,
  send: (ctx: MetaSendContext) => Promise<{ messageId: string }>,
  record: EngineMessageRecord,
): Promise<EngineSendResult> {
  const [contact] = await db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(and(eq(contacts.id, target.contactId), eq(contacts.accountId, target.accountId)))
    .limit(1)
  if (!contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const [config] = await db
    .select({ phoneNumberId: whatsappConfig.phoneNumberId, accessToken: whatsappConfig.accessToken })
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, target.accountId))
    .limit(1)
  if (!config) {
    throw new Error('WhatsApp not configured for this account')
  }
  const accessToken = decrypt(config.accessToken)

  // Numbers registered with/without a trunk 0 and Meta's sandbox
  // allow-list both need this to reliably land a message.
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of phoneVariants(sanitized)) {
    try {
      const r = await send({ phoneNumberId: config.phoneNumberId, accessToken, to: variant })
      waMessageId = r.messageId
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.update(contacts).set({ phone: workingPhone }).where(eq(contacts.id, contact.id))
  }

  let row: typeof messages.$inferSelect
  try {
    ;[row] = await db
      .insert(messages)
      .values({
        conversationId: target.conversationId,
        senderType: 'bot',
        contentType: record.contentType,
        contentText: record.contentText,
        templateName: record.templateName ?? null,
        interactivePayload: record.interactivePayload ?? null,
        messageId: waMessageId,
        status: 'sent',
        aiGenerated: record.aiGenerated ?? false,
      })
      .returning()
  } catch (err) {
    // Meta already has the message; surface the DB failure distinctly.
    throw new Error(`sent to Meta but DB insert failed: ${(err as Error).message}`)
  }
  publishMessage(target.accountId, 'INSERT', row)

  const [conv] = await db
    .update(conversations)
    .set({
      lastMessageText: record.preview ?? record.contentText ?? `[${record.contentType}]`,
      lastMessageAt: new Date(),
    })
    .where(eq(conversations.id, target.conversationId))
    .returning()
  if (conv) publishConversation(target.accountId, 'UPDATE', conv)

  return { whatsapp_message_id: waMessageId, message_id: row.id }
}
