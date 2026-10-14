import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// Meta sends are mocked; the engine's reads and writes are real.
const sends = vi.hoisted(() => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1', message_id: 'x' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1', message_id: 'x' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1', message_id: 'x' })),
}))
vi.mock('./meta-send', () => sends)

import { db } from '@/db'
import {
  automationLogs,
  automationPendingExecutions,
  automations,
  automationSteps,
  contactCustomValues,
  contacts,
  conversations,
  customFields,
  notifications,
} from '@/db/schema'
import { processDueAutomationExecutions } from '@/lib/cron/jobs'
import {
  addMember,
  createAccount,
  createContact,
  createConversation,
  describeDb,
} from '@/test/factories'
import { runAutomationsForTrigger } from './engine'

afterEach(() => vi.unstubAllGlobals())

async function seedAutomation(
  accountId: string,
  userId: string,
  steps: Array<{ stepType: string; stepConfig: Record<string, unknown> }>,
  over: Partial<typeof automations.$inferInsert> = {},
) {
  const [automation] = await db
    .insert(automations)
    .values({
      accountId,
      userId,
      name: 'A',
      triggerType: 'new_message_received',
      isActive: true,
      ...over,
    })
    .returning()
  for (const [position, step] of steps.entries()) {
    await db.insert(automationSteps).values({ automationId: automation.id, position, ...step })
  }
  return automation
}

const logsFor = (automationId: string) =>
  db.select().from(automationLogs).where(eq(automationLogs.automationId, automationId))

describeDb('runAutomationsForTrigger — tenancy', () => {
  it("refuses to run when the contact isn't in the account (GHSA-63cv-2c49-m5v3)", async () => {
    const a = await createAccount()
    const b = await createAccount()
    const foreign = await createContact(b.account.id, b.user.id, { company: 'Original' })
    const automation = await seedAutomation(a.account.id, a.user.id, [
      { stepType: 'update_contact_field', stepConfig: { field: 'company', value: 'pwned' } },
    ])

    await runAutomationsForTrigger({ accountId: a.account.id, triggerType: 'new_message_received', contactId: foreign.id })

    expect(await logsFor(automation.id)).toHaveLength(0)
    const [c] = await db.select().from(contacts).where(eq(contacts.id, foreign.id))
    expect(c.company).toBe('Original')
  })

  it('updates built-in and custom fields only within the account', async () => {
    const a = await createAccount()
    const b = await createAccount()
    const contact = await createContact(a.account.id, a.user.id)
    const [ownField] = await db
      .insert(customFields)
      .values({ accountId: a.account.id, userId: a.user.id, fieldName: 'Tier' })
      .returning()
    const [foreignField] = await db
      .insert(customFields)
      .values({ accountId: b.account.id, userId: b.user.id, fieldName: 'Tier' })
      .returning()
    await seedAutomation(a.account.id, a.user.id, [
      { stepType: 'update_contact_field', stepConfig: { field: 'company', value: 'Acme' } },
      { stepType: 'update_contact_field', stepConfig: { field: `custom:${ownField.id}`, value: '{{ vars.source }}' } },
      { stepType: 'update_contact_field', stepConfig: { field: `custom:${foreignField.id}`, value: 'x' } },
    ])

    const run = () =>
      runAutomationsForTrigger({
        accountId: a.account.id,
        triggerType: 'new_message_received',
        contactId: contact.id,
        context: { vars: { source: 'Premium' } },
      })
    await run()
    await run() // second run overwrites rather than duplicating

    const [c] = await db.select().from(contacts).where(eq(contacts.id, contact.id))
    expect(c.company).toBe('Acme')
    const values = await db.select().from(contactCustomValues).where(eq(contactCustomValues.contactId, contact.id))
    expect(values).toEqual([expect.objectContaining({ customFieldId: ownField.id, value: 'Premium' })])
  })
})

describeDb('automation logs', () => {
  it('finishes as success with every step recorded and bumps the counter', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const automation = await seedAutomation(account.id, user.id, [
      { stepType: 'update_contact_field', stepConfig: { field: 'name', value: 'A' } },
      { stepType: 'update_contact_field', stepConfig: { field: 'email', value: 'a@b.c' } },
    ])
    await runAutomationsForTrigger({ accountId: account.id, triggerType: 'new_message_received', contactId: contact.id })

    const [log] = await logsFor(automation.id)
    expect(log.status).toBe('success')
    expect(log.stepsExecuted).toHaveLength(2)
    const [after] = await db.select().from(automations).where(eq(automations.id, automation.id))
    expect(after.executionCount).toBe(1)
  })

  it('records a clear failure when a tag_added automation has no conversation to send in', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const automation = await seedAutomation(
      account.id,
      user.id,
      [{ stepType: 'send_message', stepConfig: { text: 'Hello' } }],
      { triggerType: 'tag_added', triggerConfig: { tag_id: 'tag-a' } },
    )
    await runAutomationsForTrigger({
      accountId: account.id,
      triggerType: 'tag_added',
      contactId: contact.id,
      context: { tag_id: 'tag-a' },
    })
    const [log] = await logsFor(automation.id)
    expect(log).toMatchObject({
      status: 'failed',
      errorMessage: 'tag_added automation cannot send: contact has no existing conversation',
    })
  })
})

describeDb('automation steps', () => {
  it('blocks send_webhook to a private destination without fetching (GHSA-8jqh-598v-rfxc)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const automation = await seedAutomation(account.id, user.id, [
      { stepType: 'send_webhook', stepConfig: { url: 'http://169.254.169.254/latest/meta-data/', body_template: '{}' } },
    ])
    await runAutomationsForTrigger({ accountId: account.id, triggerType: 'new_message_received', contactId: contact.id })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await logsFor(automation.id))[0].status).toBe('failed')
  })

  it('assigns the conversation to a member and notifies them; refuses non-members', async () => {
    const { account, user } = await createAccount()
    const agent = await addMember(account.id)
    const outsider = await createAccount()
    const contact = await createContact(account.id, user.id)
    const conv = await createConversation(account.id, user.id, contact.id)

    await seedAutomation(account.id, user.id, [
      { stepType: 'assign_conversation', stepConfig: { mode: 'specific', agent_id: outsider.user.id } },
    ])
    await runAutomationsForTrigger({ accountId: account.id, triggerType: 'new_message_received', contactId: contact.id })
    expect((await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].assignedAgentId).toBeNull()

    await db.delete(automations)
    await seedAutomation(account.id, user.id, [
      { stepType: 'assign_conversation', stepConfig: { mode: 'specific', agent_id: agent.user.id } },
    ])
    await runAutomationsForTrigger({ accountId: account.id, triggerType: 'new_message_received', contactId: contact.id })
    expect((await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].assignedAgentId).toBe(agent.user.id)
    expect(await db.select().from(notifications).where(eq(notifications.userId, agent.user.id))).toHaveLength(1)
  })

  it('parks at a wait step and resumes the remaining steps once due', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const automation = await seedAutomation(account.id, user.id, [
      { stepType: 'update_contact_field', stepConfig: { field: 'name', value: 'before' } },
      { stepType: 'wait', stepConfig: { amount: 1, unit: 'minutes' } },
      { stepType: 'update_contact_field', stepConfig: { field: 'name', value: 'after' } },
    ])
    await runAutomationsForTrigger({ accountId: account.id, triggerType: 'new_message_received', contactId: contact.id })
    const nameOf = async () => (await db.select().from(contacts).where(eq(contacts.id, contact.id)))[0].name
    expect(await nameOf()).toBe('before')
    expect((await logsFor(automation.id))[0].status).toBe('partial')

    // Not due yet.
    expect(await processDueAutomationExecutions()).toBe(0)
    await db.update(automationPendingExecutions).set({ runAt: new Date(Date.now() - 1000) })
    expect(await processDueAutomationExecutions()).toBe(1)
    expect(await nameOf()).toBe('after')
    const [pending] = await db.select().from(automationPendingExecutions)
    expect(pending.status).toBe('done')
  })
})
