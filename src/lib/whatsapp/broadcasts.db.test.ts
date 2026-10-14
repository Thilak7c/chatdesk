import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

const meta = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: meta.sendTemplateMessage,
}))

import { db } from '@/db'
import { broadcastRecipients, broadcasts, contacts } from '@/db/schema'
import { recomputeBroadcastCounts, updateRecipient } from '@/lib/broadcasts/counters'
import {
  createAccount,
  createBroadcast as seedBroadcast,
  createContact,
  createRecipient,
  createTemplate,
  createWhatsappConfig,
  describeDb,
} from '@/test/factories'
import { createBroadcast, deliverBroadcast, finalizeBroadcastStatus } from './broadcast-core'
import {
  claimBroadcastDelivery,
  DELIVERY_LOCK_STALE_MS,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume'
import { resolveConversationByPhone } from './resolve-conversation'

const broadcastRow = async (id: string) =>
  (await db.select().from(broadcasts).where(eq(broadcasts.id, id)))[0]
const recipientsOf = async (id: string) =>
  db.select().from(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, id))

async function seedAccount() {
  const { account, user } = await createAccount()
  await createWhatsappConfig(account.id, user.id)
  await createTemplate(account.id, user.id, { name: 'promo', bodyText: 'Hi {{1}}' })
  return { accountId: account.id, userId: user.id }
}

beforeEach(() => {
  meta.sendTemplateMessage.mockReset()
  meta.sendTemplateMessage.mockImplementation(async ({ to }: { to: string }) => ({ messageId: `wamid.${to}` }))
})

describeDb('createBroadcast + deliverBroadcast', () => {
  it('persists parent + recipients with frozen params, deduping contacts and counting rejects', async () => {
    const { accountId, userId } = await seedAccount()
    const plan = await createBroadcast(db, accountId, userId, {
      templateName: 'promo',
      recipients: [
        { to: '+14155550101', params: ['Ann'] },
        { to: '14155550101', params: ['dup'] },
        { to: 'not-a-phone' },
        { to: '+14155550102', params: ['Bob'] },
      ],
    })
    expect(plan.rejected).toBe(1)
    expect(plan.planned).toHaveLength(2)

    const b = await broadcastRow(plan.broadcastId)
    expect(b).toMatchObject({ status: 'sending', totalRecipients: 2, sentCount: 0 })
    const rows = await recipientsOf(plan.broadcastId)
    expect(rows.map((r) => r.templateParams).sort()).toEqual([['Ann'], ['Bob']])
    expect(await db.select().from(contacts).where(eq(contacts.accountId, accountId))).toHaveLength(2)
  })

  it('delivers, stamps each recipient, maintains counts and finalizes', async () => {
    const { accountId, userId } = await seedAccount()
    meta.sendTemplateMessage.mockImplementation(async ({ to }: { to: string }) => {
      if (to.endsWith('0102')) throw new Error('Meta API error: bad number')
      return { messageId: `wamid.${to}` }
    })
    const plan = await createBroadcast(db, accountId, userId, {
      templateName: 'promo',
      recipients: [{ to: '+14155550101' }, { to: '+14155550102' }],
    })
    await deliverBroadcast(db, plan)

    const b = await broadcastRow(plan.broadcastId)
    expect(b).toMatchObject({ status: 'sent', sentCount: 1, failedCount: 1 })
    const rows = await recipientsOf(plan.broadcastId)
    expect(rows.find((r) => r.status === 'sent')?.whatsappMessageId).toMatch(/^wamid\./)
    expect(rows.find((r) => r.status === 'failed')?.errorMessage).toContain('bad number')
  })

  it('rejects bad input before persisting anything', async () => {
    const { accountId, userId } = await seedAccount()
    await expect(createBroadcast(db, accountId, userId, { templateName: '', recipients: [{ to: '+14155550101' }] }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 })
    await expect(createBroadcast(db, accountId, userId, { templateName: 'promo', recipients: [] }))
      .rejects.toMatchObject({ status: 400 })
    await expect(createBroadcast(db, accountId, userId, { templateName: 'promo', recipients: [{ to: 'x' }] }))
      .rejects.toMatchObject({ status: 400 })
    expect(await db.select().from(broadcasts)).toHaveLength(0)
  })
})

describeDb('broadcast counters', () => {
  it('apply cumulative deltas on every transition and agree with a full recompute', async () => {
    const { account, user } = await createAccount()
    const b = await seedBroadcast(account.id, user.id)
    const r = []
    for (let i = 0; i < 4; i++) {
      r.push(await createRecipient(b.id, (await createContact(account.id, user.id)).id))
    }
    await updateRecipient(db, r[0].id, { status: 'sent' })
    await updateRecipient(db, r[0].id, { status: 'delivered' })
    await updateRecipient(db, r[0].id, { status: 'read' })
    await updateRecipient(db, r[1].id, { status: 'sent' })
    await updateRecipient(db, r[1].id, { status: 'replied' })
    await updateRecipient(db, r[2].id, { status: 'failed' })
    // Concurrent status changes for different recipients of one broadcast.
    await Promise.all([updateRecipient(db, r[3].id, { status: 'sent' }), updateRecipient(db, r[0].id, { status: 'replied' })])

    const incremental = await broadcastRow(b.id)
    expect(incremental).toMatchObject({ sentCount: 3, deliveredCount: 2, readCount: 2, repliedCount: 2, failedCount: 1 })
    await recomputeBroadcastCounts(db, b.id)
    expect(await broadcastRow(b.id)).toMatchObject({
      sentCount: incremental.sentCount,
      deliveredCount: incremental.deliveredCount,
      readCount: incremental.readCount,
      repliedCount: incremental.repliedCount,
      failedCount: incremental.failedCount,
    })
  })
})

describeDb('finalizeBroadcastStatus', () => {
  async function withRecipients(statuses: string[]) {
    const { account, user } = await createAccount()
    const b = await seedBroadcast(account.id, user.id)
    for (const status of statuses) {
      await createRecipient(b.id, (await createContact(account.id, user.id)).id, { status })
    }
    return b.id
  }

  it('leaves a broadcast with pending recipients in "sending"', async () => {
    const id = await withRecipients(['sent', 'pending'])
    await finalizeBroadcastStatus(db, id)
    expect((await broadcastRow(id)).status).toBe('sending')
  })

  it('marks fully-failed as failed, and anything that reached Meta as sent', async () => {
    const failed = await withRecipients(['failed', 'failed'])
    const partial = await withRecipients(['failed', 'delivered', 'failed'])
    await finalizeBroadcastStatus(db, failed)
    await finalizeBroadcastStatus(db, partial)
    expect((await broadcastRow(failed)).status).toBe('failed')
    expect((await broadcastRow(partial)).status).toBe('sent')
  })
})

describeDb('broadcast resume', () => {
  it('claims the delivery lock once, honours staleness, and is account-scoped', async () => {
    const { account, user } = await createAccount()
    const other = await createAccount()
    const b = await seedBroadcast(account.id, user.id)

    expect(await claimBroadcastDelivery(db, other.account.id, b.id)).toBe(false)
    const results = await Promise.all([1, 2, 3].map(() => claimBroadcastDelivery(db, account.id, b.id)))
    expect(results.filter(Boolean)).toHaveLength(1)

    const later = new Date(Date.now() + DELIVERY_LOCK_STALE_MS + 1000)
    expect(await claimBroadcastDelivery(db, account.id, b.id, later)).toBe(true)

    await releaseBroadcastDelivery(db, b.id)
    expect((await broadcastRow(b.id)).deliveryLockedAt).toBeNull()
  })

  it('plans outstanding recipients with frozen params, failing unsendable rows up front', async () => {
    const { accountId, userId } = await seedAccount()
    const b = await seedBroadcast(accountId, userId, { templateName: 'promo' })
    const ok1 = await createRecipient(b.id, (await createContact(accountId, userId, { phone: '+15551234567' })).id, {
      templateParams: ['A123'],
    })
    await createRecipient(b.id, (await createContact(accountId, userId, { phone: '+15559876543' })).id, {
      templateParams: null,
    })
    const bad = await createRecipient(b.id, (await createContact(accountId, userId, { phone: 'nonsense' })).id)
    await createRecipient(b.id, (await createContact(accountId, userId)).id, { status: 'sent' })

    const { plan, remaining, unsendable } = await planBroadcastResume(db, accountId, b.id, 'pending')
    expect(unsendable).toBe(1)
    expect(remaining).toBe(0)
    expect(plan.accessToken).toBe('test-access-token')
    expect(plan.templateRow?.name).toBe('promo')
    expect(plan.planned).toHaveLength(2)
    expect(plan.planned.find((p) => p.recipientRowId === ok1.id)).toEqual({
      recipientRowId: ok1.id,
      phone: '15551234567',
      params: ['A123'],
    })
    expect(plan.planned.every((p) => Array.isArray(p.params))).toBe(true)

    const badRow = (await recipientsOf(b.id)).find((r) => r.id === bad.id)
    expect(badRow?.status).toBe('failed')
    expect((await broadcastRow(b.id)).failedCount).toBe(1)
  })

  it('scopes by status, caps a pass, and refuses foreign or empty broadcasts', async () => {
    const { accountId, userId } = await seedAccount()
    const b = await seedBroadcast(accountId, userId, { templateName: 'promo' })
    const contact = await createContact(accountId, userId, { phone: '+15550000001' })
    await createRecipient(b.id, contact.id, { status: 'failed' })

    expect((await planBroadcastResume(db, accountId, b.id, 'failed')).plan.planned).toHaveLength(1)
    expect((await planBroadcastResume(db, accountId, b.id, 'all')).plan.planned).toHaveLength(1)
    await expect(planBroadcastResume(db, accountId, b.id, 'pending')).rejects.toMatchObject({ code: 'nothing_to_resume' })

    const other = await createAccount()
    await expect(planBroadcastResume(db, other.account.id, b.id, 'all')).rejects.toMatchObject({ status: 404 })

    const big = await seedBroadcast(accountId, userId, { templateName: 'promo' })
    const values = Array.from({ length: RESUME_MAX_PER_REQUEST + 5 }, (_, i) => ({
      accountId,
      userId,
      phone: `+1555${String(1000000 + i)}`,
    }))
    const many = await db.insert(contacts).values(values).returning({ id: contacts.id })
    await db.insert(broadcastRecipients).values(many.map((c) => ({ broadcastId: big.id, contactId: c.id })))
    const capped = await planBroadcastResume(db, accountId, big.id, 'pending')
    expect(capped.plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST)
    expect(capped.remaining).toBe(5)
  })
})

describeDb('resolveConversationByPhone', () => {
  it('rejects an invalid phone and an unconfigured account', async () => {
    const { account } = await createAccount()
    await expect(resolveConversationByPhone(db, account.id, 'abc')).rejects.toMatchObject({ status: 400 })
    await expect(resolveConversationByPhone(db, account.id, '+14155550123')).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
    })
  })

  it('creates the contact + conversation once, then reuses them', async () => {
    const { accountId } = await seedAccount()
    const first = await resolveConversationByPhone(db, accountId, '+14155550123', 'Jane')
    const again = await resolveConversationByPhone(db, accountId, '14155550123')
    expect(first.contactCreated).toBe(true)
    expect(again).toEqual({ ...first, contactCreated: false })
  })
})
