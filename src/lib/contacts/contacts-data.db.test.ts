import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { contacts, contactTags, conversations } from '@/db/schema'
import {
  addMember,
  createAccount,
  createContact,
  createConversation,
  createTag,
  createWhatsappConfig,
  describeDb,
} from '@/test/factories'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { findExistingContact } from './dedupe'
import { findOrCreateContact, findOrCreateConversation, resolveAuditUserId } from './find-or-create'
import { addContactTagIfAbsent, removeContactTag } from './tag-write'

describeDb('findExistingContact', () => {
  it('matches a trunk-variant of the same number, scoped to the account', async () => {
    const a = await createAccount()
    const b = await createAccount()
    const c = await createContact(a.account.id, a.user.id, { phone: '37063949836' })

    expect((await findExistingContact(db, a.account.id, '+370 063 949 836'))?.id).toBe(c.id)
    expect(await findExistingContact(db, b.account.id, '+370 063 949 836')).toBeNull()
    expect(await findExistingContact(db, a.account.id, '+1 555-123-4567')).toBeNull()
    expect(await findExistingContact(db, a.account.id, '   ')).toBeNull()
  })
})

describeDb('findOrCreateContact / findOrCreateConversation', () => {
  it('creates once, then finds the same rows', async () => {
    const { account, user } = await createAccount()
    const base = { accountId: account.id, auditUserId: user.id }
    const first = await findOrCreateContact(db, { ...base, phone: '+14155550123', name: 'Jane' })
    const again = await findOrCreateContact(db, { ...base, phone: '14155550123' })
    expect(first.created).toBe(true)
    expect(again).toMatchObject({ created: false, contact: { id: first.contact.id } })

    const convArgs = { accountId: account.id, contactId: first.contact.id, auditUserId: user.id }
    const conv = await findOrCreateConversation(db, convArgs)
    const conv2 = await findOrCreateConversation(db, convArgs)
    expect(conv.created).toBe(true)
    expect(conv2).toMatchObject({ created: false, conversation: { id: conv.conversation.id } })
  })

  it('converges concurrent creates on one contact and one conversation', async () => {
    const { account, user } = await createAccount()
    const args = { accountId: account.id, auditUserId: user.id, phone: '+14155550999' }
    const results = await Promise.all(Array.from({ length: 5 }, () => findOrCreateContact(db, args)))
    expect(new Set(results.map((r) => r.contact.id)).size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)

    const contactId = results[0].contact.id
    const convs = await Promise.all(
      Array.from({ length: 5 }, () =>
        findOrCreateConversation(db, { accountId: account.id, contactId, auditUserId: user.id }),
      ),
    )
    expect(new Set(convs.map((c) => c.conversation.id)).size).toBe(1)
    const rows = await db.select().from(conversations).where(eq(conversations.contactId, contactId))
    expect(rows).toHaveLength(1)
  })

  it('refreshes the name only when asked', async () => {
    const { account, user } = await createAccount()
    const c = await createContact(account.id, user.id, { phone: '+14155550111', name: 'Old' })
    const base = { accountId: account.id, auditUserId: user.id, phone: c.phone, name: 'New' }
    const nameOf = async () => (await db.select().from(contacts).where(eq(contacts.id, c.id)))[0].name

    await findOrCreateContact(db, base)
    expect(await nameOf()).toBe('Old')
    await findOrCreateContact(db, { ...base, refreshName: true })
    expect(await nameOf()).toBe('New')
  })

  it('attributes system-created rows to the WhatsApp config owner, else the account owner', async () => {
    const { account, user } = await createAccount()
    expect(await resolveAuditUserId(db, account.id)).toBe(user.id)
    const admin = await addMember(account.id, 'admin')
    await createWhatsappConfig(account.id, admin.user.id)
    expect(await resolveAuditUserId(db, account.id)).toBe(admin.user.id)
  })
})

describeDb('contact tag writes', () => {
  it('adds a tag exactly once and removes it', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const tag = await createTag(account.id, user.id)
    const input = { accountId: account.id, contactId: contact.id, tagId: tag.id }

    expect(await addContactTagIfAbsent(db, input)).toBe(true)
    expect(await addContactTagIfAbsent(db, input)).toBe(false)
    expect(await db.select().from(contactTags)).toHaveLength(1)

    await removeContactTag(db, input)
    expect(await db.select().from(contactTags)).toHaveLength(0)
  })

  it('refuses contacts and tags from another account', async () => {
    const a = await createAccount()
    const b = await createAccount()
    const contact = await createContact(a.account.id, a.user.id)
    const foreignContact = await createContact(b.account.id, b.user.id)
    const ownTag = await createTag(a.account.id, a.user.id)
    const foreignTag = await createTag(b.account.id, b.user.id)

    await expect(
      addContactTagIfAbsent(db, { accountId: a.account.id, contactId: contact.id, tagId: foreignTag.id }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      addContactTagIfAbsent(db, { accountId: a.account.id, contactId: foreignContact.id, tagId: ownTag.id }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describeDb('reopenClosedConversation', () => {
  async function seed(status: string) {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    return createConversation(account.id, user.id, contact.id, { status })
  }
  const statusOf = async (id: string) =>
    (await db.select().from(conversations).where(eq(conversations.id, id)))[0].status

  it('flips a closed conversation back to open', async () => {
    const conv = await seed('closed')
    expect(await reopenClosedConversation(db, conv)).toBe(true)
    expect(await statusOf(conv.id)).toBe('open')
  })

  it('guards the write in SQL: a stale "closed" snapshot does not reopen', async () => {
    const conv = await seed('pending')
    expect(await reopenClosedConversation(db, { id: conv.id, status: 'closed' })).toBe(false)
    expect(await statusOf(conv.id)).toBe('pending')
  })

  it.each(['open', 'pending', undefined])('is a no-op for status %s', async (status) => {
    const id = '00000000-0000-0000-0000-000000000000'
    expect(await reopenClosedConversation(db, { id, status })).toBe(false)
  })
})
