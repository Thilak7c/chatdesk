import { expect, it } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { contactTags, conversations, messages } from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { buildPage, decodeCursor, keysetWhere } from '@/lib/api/v1/pagination'
import {
  addMember,
  createAccount,
  createContact,
  createConversation,
  createMessage,
  createTag,
  describeDb,
} from '@/test/factories'
import { fetchConversations } from './conversation-query'

describeDb('fetchConversations', () => {
  it('embeds contact tags and the assignee, scoped to the account', async () => {
    const a = await createAccount()
    const b = await createAccount()
    const agent = await addMember(a.account.id, 'agent')
    const contact = await createContact(a.account.id, a.user.id, { name: 'Jane' })
    const tag = await createTag(a.account.id, a.user.id, 'VIP')
    await db.insert(contactTags).values({ contactId: contact.id, tagId: tag.id })
    const conv = await createConversation(a.account.id, a.user.id, contact.id, {
      assignedAgentId: agent.user.id,
    })
    const other = await createContact(b.account.id, b.user.id)
    await createConversation(b.account.id, b.user.id, other.id)

    const rows = await fetchConversations(db, { accountId: a.account.id })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: conv.id,
      contact: { name: 'Jane', tags: [{ id: tag.id, name: 'VIP' }] },
      assignee: { user_id: agent.user.id },
    })
  })
})

describeDb('keyset pagination', () => {
  it('walks every row exactly once, including same-timestamp ties', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const conv = await createConversation(account.id, user.id, contact.id)
    const sameTs = new Date('2026-01-01T00:00:00.123Z')
    for (let i = 0; i < 7; i++) {
      await createMessage(conv.id, { createdAt: i < 4 ? sameTs : new Date(Date.UTC(2026, 0, 2, 0, 0, i)) })
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const rows: (typeof messages.$inferSelect)[] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conv.id),
            keysetWhere(decodeCursor(cursor), messages.createdAt, messages.id),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(3)
      const result: { items: { id: string }[]; nextCursor: string | null } = buildPage(rows.map(toSnake), 2)
      const { items, nextCursor } = result
      seen.push(...items.map((m) => m.id))
      if (!nextCursor) break
      cursor = nextCursor
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })
})

describeDb('conversations table invariants', () => {
  it('allows only one conversation per contact per account', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    await createConversation(account.id, user.id, contact.id)
    await expect(
      db.insert(conversations).values({ accountId: account.id, userId: user.id, contactId: contact.id }),
    ).rejects.toThrow()
  })
})
