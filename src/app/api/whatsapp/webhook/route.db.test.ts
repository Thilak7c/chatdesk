import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// Downstream engines and Meta are mocked; message storage, idempotency,
// counters and status mirroring run against the real database.
const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => Promise<void> | void)[],
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  puts: [] as { bucket: string; path: string; contentType: string }[],
  putError: null as Error | null,
  automationStarted: 0,
  automationCompleted: 0,
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: (cb: () => Promise<void> | void) => void h.afterCallbacks.push(cb),
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => true }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}))
vi.mock('@/lib/storage/object-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  putObject: async (bucket: string, path: string, _body: Buffer, contentType: string) => {
    h.puts.push({ bucket, path, contentType })
    if (h.putError) throw h.putError
  },
}))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomationsForTrigger }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhookEvent }))

import { db } from '@/db'
import { broadcastRecipients, broadcasts, contacts, conversations, messages } from '@/db/schema'
import {
  createAccount,
  createBroadcast,
  createContact,
  createMessage,
  createRecipient,
  createWhatsappConfig,
  describeDb,
} from '@/test/factories'
import { POST } from './route'

const PHONE = '15551230000'
const TEXT = { id: 'wamid.TEST1', from: PHONE, timestamp: '1700000000', type: 'text', text: { body: 'hello' } }
const IMAGE = {
  id: 'wamid.IMG1',
  from: PHONE,
  timestamp: '1700000000',
  type: 'image',
  image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
}

async function seed(over: { mirrorInboundMedia?: boolean } = {}) {
  const { account, user } = await createAccount()
  const config = await createWhatsappConfig(account.id, user.id, over)
  return { accountId: account.id, userId: user.id, phoneNumberId: config.phoneNumberId }
}

async function deliver(phoneNumberId: string, value: Record<string, unknown>) {
  const body = { entry: [{ id: 'e', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, ...value } }] }] }
  const res = await POST(
    new Request('http://app.test/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'x-forwarded-host': 'app.test', 'x-forwarded-proto': 'https' },
    }),
  )
  // Drain after() exactly as the runtime would.
  const callbacks = h.afterCallbacks.splice(0)
  for (const cb of callbacks) await cb()
  return res
}

const inbound = (phoneNumberId: string, message: Record<string, unknown> = TEXT) =>
  deliver(phoneNumberId, { contacts: [{ wa_id: PHONE, profile: { name: 'Ada' } }], messages: [message] })

async function onlyConversation(accountId: string) {
  const rows = await db.select().from(conversations).where(eq(conversations.accountId, accountId))
  expect(rows).toHaveLength(1)
  return rows[0]
}
const messagesIn = (conversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, conversationId))

beforeEach(() => {
  h.afterCallbacks.length = 0
  h.puts.length = 0
  h.putError = null
  h.automationStarted = 0
  h.automationCompleted = 0
  h.getMediaUrl.mockResolvedValue({ url: 'https://lookaside.fbsbx.com/x', mimeType: 'image/jpeg', fileSize: 2048 })
  h.downloadMedia.mockResolvedValue({ buffer: Buffer.alloc(2048), contentType: 'image/jpeg' })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.automationStarted++
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        h.automationCompleted++
        resolve()
      }, 0),
    )
  })
})

describeDb('inbound webhook: contact, conversation and message', () => {
  it('creates the contact + conversation, stores the message and bumps unread', async () => {
    const { accountId, phoneNumberId } = await seed()
    expect((await inbound(phoneNumberId)).status).toBe(200)

    const [contact] = await db.select().from(contacts).where(eq(contacts.accountId, accountId))
    expect(contact).toMatchObject({ name: 'Ada', phone: PHONE })
    const conv = await onlyConversation(accountId)
    expect(conv).toMatchObject({ unreadCount: 1, lastMessageText: 'hello' })
    const [msg] = await messagesIn(conv.id)
    expect(msg).toMatchObject({ senderType: 'customer', contentText: 'hello', messageId: 'wamid.TEST1', status: 'delivered' })
    expect(msg.createdAt.toISOString()).toBe('2023-11-14T22:13:20.000Z')
  })

  it('ignores a delivery for a number no account owns', async () => {
    await seed()
    await inbound('pn-unknown')
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})

describeDb('inbound webhook: idempotency and atomic unread', () => {
  it('a replayed delivery is a no-op: one row, one bump, one fan-out', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId)
    await inbound(phoneNumberId)
    const conv = await onlyConversation(accountId)
    expect(await messagesIn(conv.id)).toHaveLength(1)
    expect(conv.unreadCount).toBe(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent.mock.calls.filter((c) => c[2] === 'message.received')).toHaveLength(1)
  })

  it('counts every message when distinct deliveries race', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId) // establish the conversation first
    await Promise.all(
      [2, 3, 4, 5].map((i) => inbound(phoneNumberId, { ...TEXT, id: `wamid.R${i}` })),
    )
    expect((await onlyConversation(accountId)).unreadCount).toBe(5)
  })

  it('reopens a closed conversation when the customer writes again', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId)
    await db.update(conversations).set({ status: 'closed' })
    await inbound(phoneNumberId, { ...TEXT, id: 'wamid.AGAIN' })
    expect((await onlyConversation(accountId)).status).toBe('open')
  })
})

describeDb('inbound webhook: template quick-reply buttons', () => {
  const tapMessage = {
    id: 'wamid.BTN1',
    from: PHONE,
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply and routes it to flows + automations, not AI', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId, tapMessage)
    const [msg] = await messagesIn((await onlyConversation(accountId)).id)
    expect(msg).toMatchObject({
      contentType: 'interactive',
      contentText: 'Yes, interested',
      interactiveReplyId: 'YES_INTERESTED',
      replyToMessageId: null,
    })
    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { kind: 'interactive_reply', reply_id: 'YES_INTERESTED', reply_title: 'Yes, interested', meta_message_id: 'wamid.BTN1' },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map((c) => (c[0] as { triggerType: string }).triggerType)
    expect(triggers).toContain('interactive_reply')
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('falls back to the label when the button carries no payload', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId, { ...tapMessage, button: { text: 'Track my order' } })
    const [msg] = await messagesIn((await onlyConversation(accountId)).id)
    expect(msg).toMatchObject({ contentText: 'Track my order', interactiveReplyId: 'Track my order' })
  })

  it('links a swipe-reply to the quoted message in the same conversation', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId)
    const conv = await onlyConversation(accountId)
    const ours = await createMessage(conv.id, { senderType: 'agent', messageId: 'wamid.OURS' })
    await inbound(phoneNumberId, { ...TEXT, id: 'wamid.REPLY', context: { id: 'wamid.OURS' } })
    const reply = (await messagesIn(conv.id)).find((m) => m.messageId === 'wamid.REPLY')
    expect(reply?.replyToMessageId).toBe(ours.id)
  })
})

describeDb('inbound webhook: media mirroring', () => {
  it('stores a durable storage URL and the MIME type', async () => {
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId, IMAGE)
    const path = `account-${accountId}/inbound/1234567890123456-image-1700000000.jpg`
    expect(h.puts).toEqual([{ bucket: 'chat-media', path, contentType: 'image/jpeg' }])
    const [msg] = await messagesIn((await onlyConversation(accountId)).id)
    expect(msg).toMatchObject({
      mediaUrl: `https://app.test/api/storage/chat-media/${path}`,
      mediaType: 'image/jpeg',
    })
  })

  it.each([
    ['the upload is refused', () => void (h.putError = new Error('mime type not supported'))],
    ['the download throws', () => void h.downloadMedia.mockRejectedValueOnce(new Error('404'))],
  ])('falls back to the proxy URL when %s', async (_name, arrange) => {
    arrange()
    const { accountId, phoneNumberId } = await seed()
    await inbound(phoneNumberId, IMAGE)
    const [msg] = await messagesIn((await onlyConversation(accountId)).id)
    expect(msg.mediaUrl).toBe('/api/whatsapp/media/1234567890123456')
  })

  it('skips oversized media without downloading, and honours the opt-out', async () => {
    const big = await seed()
    h.getMediaUrl.mockResolvedValueOnce({ url: 'https://x', mimeType: 'application/pdf', fileSize: 40 * 1024 * 1024 })
    await inbound(big.phoneNumberId, {
      id: 'wamid.DOC1',
      from: PHONE,
      timestamp: '1700000000',
      type: 'document',
      document: { id: '999', mime_type: 'application/pdf', filename: 'huge.pdf' },
    })
    const optedOut = await seed({ mirrorInboundMedia: false })
    await inbound(optedOut.phoneNumberId, IMAGE)

    expect(h.downloadMedia).not.toHaveBeenCalled()
    expect(h.puts).toHaveLength(0)
    const [doc] = await messagesIn((await onlyConversation(big.accountId)).id)
    expect(doc).toMatchObject({ mediaUrl: '/api/whatsapp/media/999', mediaType: 'application/pdf' })
  })

  it("names a document after the sender's filename", async () => {
    const { accountId, phoneNumberId } = await seed()
    h.getMediaUrl.mockResolvedValueOnce({ url: 'https://x', mimeType: 'application/pdf', fileSize: 4096 })
    h.downloadMedia.mockResolvedValueOnce({ buffer: Buffer.alloc(4096), contentType: 'application/pdf' })
    await inbound(phoneNumberId, {
      id: 'wamid.DOC2',
      from: PHONE,
      timestamp: '1700000000',
      type: 'document',
      document: { id: '1234567890123456', mime_type: 'application/pdf', filename: 'invoice.pdf', caption: 'look' },
    })
    expect(h.puts[0].path).toBe(`account-${accountId}/inbound/1234567890123456-invoice.pdf`)
  })
})

describeDb('inbound webhook: status updates', () => {
  it('advances message status and the broadcast recipient + counters, never backwards', async () => {
    const { accountId, userId, phoneNumberId } = await seed()
    const contact = await createContact(accountId, userId)
    const b = await createBroadcast(accountId, userId)
    const r = await createRecipient(b.id, contact.id, { status: 'sent', whatsappMessageId: 'wamid.B1' })
    await db.update(broadcasts).set({ sentCount: 1 }).where(eq(broadcasts.id, b.id))

    const status = (s: string, ts = '1700000100') =>
      deliver(phoneNumberId, { statuses: [{ id: 'wamid.B1', status: s, timestamp: ts, recipient_id: PHONE }] })
    await status('delivered')
    await status('read')
    await status('delivered') // out-of-order replay must not regress

    const [rec] = await db.select().from(broadcastRecipients).where(eq(broadcastRecipients.id, r.id))
    expect(rec.status).toBe('read')
    expect(rec.readAt?.toISOString()).toBe('2023-11-14T22:15:00.000Z')
    const [bc] = await db.select().from(broadcasts).where(eq(broadcasts.id, b.id))
    expect(bc).toMatchObject({ sentCount: 1, deliveredCount: 1, readCount: 1 })
  })

  it('marks the latest broadcast to a contact replied when they write back', async () => {
    const { accountId, userId, phoneNumberId } = await seed()
    const contact = await createContact(accountId, userId, { phone: PHONE })
    const b = await createBroadcast(accountId, userId)
    await createRecipient(b.id, contact.id, { status: 'delivered' })
    await inbound(phoneNumberId)
    const [bc] = await db.select().from(broadcasts).where(eq(broadcasts.id, b.id))
    expect(bc.repliedCount).toBe(1)
  })
})

describeDb('inbound webhook: after() awaits automations', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    const { phoneNumberId } = await seed()
    await inbound(phoneNumberId)
    // new_contact_created + first_inbound_message + new_message_received + keyword_match.
    expect(h.automationStarted).toBe(4)
    expect(h.automationCompleted).toBe(4)
  })
})
