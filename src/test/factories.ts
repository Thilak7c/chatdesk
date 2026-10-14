// Test fixtures for the `db` test project. Each factory inserts real
// rows and returns them; override any column through `over`.

import { describe } from 'vitest'

import { db } from '@/db'
import {
  accounts,
  broadcastRecipients,
  broadcasts,
  contacts,
  conversations,
  messages,
  messageTemplates,
  profiles,
  tags,
  users,
  whatsappConfig,
} from '@/db/schema'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { AccountRole } from '@/lib/auth/roles'

/** `describe` that skips when no test database is configured. */
export const describeDb = describe.skipIf(!process.env.TEST_DATABASE_URL)

let seq = 0
const next = () => ++seq

/** A user with a personal account they own (as signup creates). */
export async function createAccount(over: { email?: string; name?: string } = {}) {
  const n = next()
  const [user] = await db
    .insert(users)
    .values({ email: over.email ?? `owner${n}@example.test`, passwordHash: 'x' })
    .returning()
  const [account] = await db
    .insert(accounts)
    .values({ name: over.name ?? `Account ${n}`, ownerUserId: user.id })
    .returning()
  const [profile] = await db
    .insert(profiles)
    .values({
      userId: user.id,
      accountId: account.id,
      accountRole: 'owner',
      fullName: `Owner ${n}`,
      email: user.email,
    })
    .returning()
  return { user, account, profile }
}

/** Another user who is a member of `accountId` with `role`. */
export async function addMember(accountId: string, role: AccountRole = 'agent') {
  const n = next()
  const [user] = await db
    .insert(users)
    .values({ email: `member${n}@example.test`, passwordHash: 'x' })
    .returning()
  const [profile] = await db
    .insert(profiles)
    .values({ userId: user.id, accountId, accountRole: role, fullName: `Member ${n}`, email: user.email })
    .returning()
  return { user, profile }
}

export async function createContact(
  accountId: string,
  userId: string,
  over: Partial<typeof contacts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(contacts)
    .values({ accountId, userId, phone: `+1415555${String(1000 + next()).slice(-4)}`, ...over })
    .returning()
  return row
}

export async function createConversation(
  accountId: string,
  userId: string,
  contactId: string,
  over: Partial<typeof conversations.$inferInsert> = {},
) {
  const [row] = await db
    .insert(conversations)
    .values({ accountId, userId, contactId, ...over })
    .returning()
  return row
}

export async function createMessage(
  conversationId: string,
  over: Partial<typeof messages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(messages)
    .values({ conversationId, senderType: 'customer', contentText: 'hello', ...over })
    .returning()
  return row
}

export async function createTag(accountId: string, userId: string, name = `tag${next()}`) {
  const [row] = await db.insert(tags).values({ accountId, userId, name }).returning()
  return row
}

export async function createWhatsappConfig(
  accountId: string,
  userId: string,
  over: Partial<typeof whatsappConfig.$inferInsert> = {},
) {
  const [row] = await db
    .insert(whatsappConfig)
    .values({
      accountId,
      userId,
      phoneNumberId: `pn-${next()}`,
      wabaId: 'waba-1',
      accessToken: encrypt('test-access-token'),
      status: 'connected',
      ...over,
    })
    .returning()
  return row
}

export async function createTemplate(
  accountId: string,
  userId: string,
  over: Partial<typeof messageTemplates.$inferInsert> = {},
) {
  const [row] = await db
    .insert(messageTemplates)
    .values({
      accountId,
      userId,
      name: `tpl_${next()}`,
      language: 'en_US',
      bodyText: 'Hello {{1}}',
      status: 'APPROVED',
      category: 'Marketing',
      ...over,
    })
    .returning()
  return row
}

export async function createBroadcast(
  accountId: string,
  userId: string,
  over: Partial<typeof broadcasts.$inferInsert> = {},
) {
  const [row] = await db
    .insert(broadcasts)
    .values({ accountId, userId, name: `Broadcast ${next()}`, templateName: 'tpl', status: 'sending', ...over })
    .returning()
  return row
}

export async function createRecipient(
  broadcastId: string,
  contactId: string,
  over: Partial<typeof broadcastRecipients.$inferInsert> = {},
) {
  const [row] = await db
    .insert(broadcastRecipients)
    .values({ broadcastId, contactId, status: 'pending', ...over })
    .returning()
  return row
}
