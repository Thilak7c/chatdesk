import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

vi.mock('next/headers', () => import('@/test/request-context'))
const meta = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: meta.sendTemplateMessage,
}))

import { db } from '@/db'
import { conversations, messages } from '@/db/schema'
import { resetCookies, signInAs } from '@/test/request-context'
import {
  addMember,
  createAccount,
  createContact,
  createConversation,
  createTemplate,
  createWhatsappConfig,
  describeDb,
} from '@/test/factories'
import { POST } from './route'

async function seed() {
  const { account, user } = await createAccount()
  await createWhatsappConfig(account.id, user.id)
  await createTemplate(account.id, user.id, { name: 'order_update', bodyText: 'Order {{1}}' })
  const contact = await createContact(account.id, user.id, { phone: '+15551234567' })
  return { account, user, contact }
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const templateTo = (contactId: string) =>
  post({ contact_id: contactId, message_type: 'template', template_name: 'order_update', template_params: ['A1'] })

beforeEach(() => {
  resetCookies()
  meta.sendTemplateMessage.mockClear()
})

describeDb('POST /api/whatsapp/send — contact_id template path', () => {
  it('opens a conversation for a contact with none, then sends and records the template', async () => {
    const { user, contact } = await seed()
    await signInAs(user.id)

    const res = await templateTo(contact.id)
    expect(res.status).toBe(200)
    expect((await res.json()).whatsapp_message_id).toBe('wamid-1')

    const convs = await db.select().from(conversations).where(eq(conversations.contactId, contact.id))
    expect(convs).toHaveLength(1)
    // Meta wants bare E.164 digits.
    expect((meta.sendTemplateMessage.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe('15551234567')
    const [msg] = await db.select().from(messages).where(eq(messages.conversationId, convs[0].id))
    expect(msg).toMatchObject({ contentType: 'template', templateName: 'order_update', senderType: 'agent', contentText: 'Order A1' })
  })

  it('reuses the existing conversation instead of creating a duplicate', async () => {
    const { account, user, contact } = await seed()
    const existing = await createConversation(account.id, user.id, contact.id)
    await signInAs(user.id)
    expect((await templateTo(contact.id)).status).toBe(200)
    const convs = await db.select().from(conversations).where(eq(conversations.contactId, contact.id))
    expect(convs.map((c) => c.id)).toEqual([existing.id])
  })

  it("404s another account's contact and never reaches Meta", async () => {
    const { user } = await seed()
    const other = await seed()
    await signInAs(user.id)
    const res = await templateTo(other.contact.id)
    expect(res.status).toBe(404)
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s without a target', async () => {
    const { user } = await seed()
    await signInAs(user.id)
    expect((await post({ message_type: 'template', template_name: 'x' })).status).toBe(400)
  })
})

describeDb('POST /api/whatsapp/send — auth', () => {
  it('401s without a session', async () => {
    const { contact } = await seed()
    expect((await templateTo(contact.id)).status).toBe(401)
  })

  it('refuses a viewer with 403 before any outbound call, and allows an agent', async () => {
    const { account, contact } = await seed()
    const viewer = await addMember(account.id, 'viewer')
    await signInAs(viewer.user.id)
    expect((await templateTo(contact.id)).status).toBe(403)
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled()

    const agent = await addMember(account.id, 'agent')
    await signInAs(agent.user.id)
    expect((await templateTo(contact.id)).status).toBe(200)
  })
})
