import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// Meta is mocked; everything else (lookups, persistence, flow pausing)
// runs against the real database.
const meta = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.tpl' })),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
}))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...meta,
}))

import { db } from '@/db'
import { conversations, flowRuns, flows, messages } from '@/db/schema'
import {
  createAccount,
  createContact,
  createConversation,
  createMessage,
  createTemplate,
  createWhatsappConfig,
  describeDb,
} from '@/test/factories'
import { sendMessageToConversation, SendMessageError } from './send-message'

async function seed() {
  const { account, user } = await createAccount()
  await createWhatsappConfig(account.id, user.id)
  const contact = await createContact(account.id, user.id, { phone: '+15551234567' })
  const conversation = await createConversation(account.id, user.id, contact.id)
  return { account, user, contact, conversation }
}

const lastMessage = async (conversationId: string) =>
  (await db.select().from(messages).where(eq(messages.conversationId, conversationId)))[0]
const conversationRow = async (id: string) =>
  (await db.select().from(conversations).where(eq(conversations.id, id)))[0]

beforeEach(() => {
  meta.sendTemplateMessage.mockClear()
  meta.sendTextMessage.mockClear()
})

describeDb('sendMessageToConversation — persistence', () => {
  it('sends a text message, stores it and updates the conversation preview', async () => {
    const { account, conversation } = await seed()
    const result = await sendMessageToConversation(db, account.id, {
      conversationId: conversation.id,
      messageType: 'text',
      contentText: 'Hi there',
    })
    expect(result.whatsappMessageId).toBe('wamid.text')
    expect(await lastMessage(conversation.id)).toMatchObject({
      id: result.messageId,
      senderType: 'agent',
      contentText: 'Hi there',
      messageId: 'wamid.text',
      status: 'sent',
    })
    expect((await conversationRow(conversation.id)).lastMessageText).toBe('Hi there')
  })

  it('stores the substituted template body when the caller sends no text', async () => {
    const { account, user, conversation } = await seed()
    await createTemplate(account.id, user.id, {
      name: 'order_update',
      language: 'en',
      bodyText: 'Your order {{1}} ships on {{2}}',
    })
    await sendMessageToConversation(db, account.id, {
      conversationId: conversation.id,
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    })
    expect((await lastMessage(conversation.id)).contentText).toBe('Your order A123 ships on Friday')
    expect((await conversationRow(conversation.id)).lastMessageText).toBe('Your order A123 ships on Friday')
    // Sends the local row's language when the caller names none.
    expect((meta.sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0].language).toBe('en')
  })

  it('keeps the composer text, reads structured params, and leaves null without a local row', async () => {
    const { account, user, conversation } = await seed()
    await createTemplate(account.id, user.id, { name: 'order_update', bodyText: 'Order {{1}}' })

    await sendMessageToConversation(db, account.id, {
      conversationId: conversation.id,
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456'] },
    })
    expect((await lastMessage(conversation.id)).contentText).toBe('Order B456')

    const other = await seed()
    await sendMessageToConversation(db, other.account.id, {
      conversationId: other.conversation.id,
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['x'],
    })
    expect((await lastMessage(other.conversation.id)).contentText).toBeNull()
    expect((await conversationRow(other.conversation.id)).lastMessageText).toBe('[template]')
  })

  it('pauses an active flow run for the contact (the agent stepped in)', async () => {
    const { account, user, contact, conversation } = await seed()
    const [flow] = await db
      .insert(flows)
      .values({ accountId: account.id, userId: user.id, name: 'F', triggerType: 'keyword', status: 'active' })
      .returning()
    const [run] = await db
      .insert(flowRuns)
      .values({ flowId: flow.id, accountId: account.id, userId: user.id, contactId: contact.id, conversationId: conversation.id })
      .returning()

    await sendMessageToConversation(db, account.id, {
      conversationId: conversation.id,
      messageType: 'text',
      contentText: 'taking over',
    })
    const [after] = await db.select().from(flowRuns).where(eq(flowRuns.id, run.id))
    expect(after).toMatchObject({ status: 'paused_by_agent', endReason: 'agent_replied' })
  })
})

describeDb('sendMessageToConversation — tenancy', () => {
  it("404s another account's conversation without calling Meta", async () => {
    const a = await seed()
    const b = await seed()
    await expect(
      sendMessageToConversation(db, a.account.id, {
        conversationId: b.conversation.id,
        messageType: 'text',
        contentText: 'hi',
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(meta.sendTextMessage).not.toHaveBeenCalled()
  })

  it('refuses a reply target from a different conversation', async () => {
    const a = await seed()
    const otherContact = await createContact(a.account.id, a.user.id)
    const otherConv = await createConversation(a.account.id, a.user.id, otherContact.id)
    const foreign = await createMessage(otherConv.id, { messageId: 'wamid.x' })
    await expect(
      sendMessageToConversation(db, a.account.id, {
        conversationId: a.conversation.id,
        messageType: 'text',
        contentText: 'hi',
        replyToMessageId: foreign.id,
      }),
    ).rejects.toBeInstanceOf(SendMessageError)
  })

  it('fails with whatsapp_not_configured when the account has no config', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const conv = await createConversation(account.id, user.id, contact.id)
    await expect(
      sendMessageToConversation(db, account.id, {
        conversationId: conv.id,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        // Audio is exempt from the caption cap, so validation passes and
        // the send reaches the config lookup.
        contentText: 'a'.repeat(2000),
      }),
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured' })
  })
})
