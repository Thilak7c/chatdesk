import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// In-memory stand-in for next/headers so session code runs outside a
// request. `jar` is the browser's cookie jar.
const jar = vi.hoisted(() => new Map<string, string>())
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
}))
// React's request cache would memoise across tests in one process.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cache: <T,>(fn: T) => fn,
}))

import { db } from '@/db'
import { accountInvitations, accounts, contacts, profiles, sessions, users } from '@/db/schema'
import { addMember, createAccount, createContact, describeDb } from '@/test/factories'
import { hashInviteToken, generateInviteToken } from './invitations'
import { getCurrentAccount, requireRole, UnauthorizedError, ForbiddenError } from './account'
import { createSession, destroyAllSessionsForUser, destroyCurrentSession, getSession, SESSION_COOKIE } from './session'
import {
  changePassword,
  createPasswordResetToken,
  createUserWithPersonalAccount,
  EmailTakenError,
  resetPasswordWithToken,
  verifyCredentials,
} from './users'
import {
  peekInvitation,
  redeemInvitation,
  removeMember,
  setMemberRole,
  transferOwnership,
} from '@/lib/account/membership'

beforeEach(() => jar.clear())

describeDb('signup + credentials', () => {
  it('creates user, owned account and owner profile; logs in case-insensitively', async () => {
    const { userId, accountId } = await createUserWithPersonalAccount({
      email: 'Jane@Example.test',
      password: 'correct horse',
      fullName: 'Jane',
    })
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId))
    expect(profile).toMatchObject({ accountId, accountRole: 'owner', email: 'jane@example.test' })
    expect((await db.select().from(accounts).where(eq(accounts.id, accountId)))[0].ownerUserId).toBe(userId)

    expect(await verifyCredentials('JANE@example.test', 'correct horse')).toBe(userId)
    expect(await verifyCredentials('jane@example.test', 'wrong')).toBeNull()
    expect(await verifyCredentials('nobody@example.test', 'correct horse')).toBeNull()
  })

  it('refuses a duplicate email', async () => {
    await createUserWithPersonalAccount({ email: 'dup@example.test', password: 'password1', fullName: '' })
    await expect(
      createUserWithPersonalAccount({ email: 'DUP@example.test', password: 'password1', fullName: '' }),
    ).rejects.toBeInstanceOf(EmailTakenError)
  })
})

describeDb('sessions', () => {
  it('stores only a hash, resolves the session, and dies on sign-out', async () => {
    const { user } = await createAccount()
    await createSession(user.id)
    const token = jar.get(SESSION_COOKIE)!
    const [row] = await db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(row.tokenHash).not.toBe(token)
    expect(row.userAgent).toBe('vitest')

    expect((await getSession())?.user.id).toBe(user.id)
    await destroyCurrentSession()
    expect(jar.has(SESSION_COOKIE)).toBe(false)
    jar.set(SESSION_COOKIE, token) // a stolen copy of the old cookie
    expect(await getSession()).toBeNull()
  })

  it('rejects expired sessions and signs out every device', async () => {
    const { user } = await createAccount()
    await createSession(user.id)
    const token = jar.get(SESSION_COOKIE)!
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) })
    expect(await getSession()).toBeNull()

    await createSession(user.id)
    await destroyAllSessionsForUser(user.id)
    expect(await getSession()).toBeNull()
    jar.set(SESSION_COOKIE, token)
    expect(await getSession()).toBeNull()
  })
})

describeDb('getCurrentAccount / requireRole', () => {
  it('resolves user, account and role from the session', async () => {
    const { user, account, profile } = await createAccount({ name: 'Acme' })
    await createSession(user.id)
    const ctx = await getCurrentAccount()
    expect(ctx).toMatchObject({
      userId: user.id,
      accountId: account.id,
      profileId: profile.id,
      role: 'owner',
      account: { name: 'Acme', defaultCurrency: 'USD' },
    })
  })

  it('throws Unauthorized without a session and Forbidden below the required role', async () => {
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError)
    const { account } = await createAccount()
    const viewer = await addMember(account.id, 'viewer')
    await createSession(viewer.user.id)
    await expect(requireRole('agent')).rejects.toBeInstanceOf(ForbiddenError)
    expect((await requireRole('viewer')).role).toBe('viewer')
  })
})

describeDb('password changes', () => {
  it('changePassword keeps this session and revokes the others', async () => {
    const { userId } = await createUserWithPersonalAccount({ email: 'p@example.test', password: 'old-password', fullName: '' })
    await createSession(userId)
    const otherDevice = jar.get(SESSION_COOKIE)!
    await createSession(userId)
    const keep = (await getSession())!.id

    await changePassword(userId, 'new-password', keep)
    expect(await verifyCredentials('p@example.test', 'new-password')).toBe(userId)
    const remaining = await db.select().from(sessions).where(eq(sessions.userId, userId))
    expect(remaining.map((s) => s.id)).toEqual([keep])
    jar.set(SESSION_COOKIE, otherDevice)
    expect(await getSession()).toBeNull()
  })

  it('reset tokens are single-use, expire, and revoke every session', async () => {
    const { userId } = await createUserWithPersonalAccount({ email: 'r@example.test', password: 'old-password', fullName: '' })
    await createSession(userId)
    expect(await createPasswordResetToken('nobody@example.test')).toBeNull()
    const issued = (await createPasswordResetToken('R@example.test'))!

    const results = await Promise.all([
      resetPasswordWithToken(issued.token, 'brand-new-pass'),
      resetPasswordWithToken(issued.token, 'other-new-pass'),
    ])
    expect(results.filter(Boolean)).toEqual([userId])
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0)

    const expired = (await createPasswordResetToken('r@example.test'))!
    await db.execute(`update password_reset_tokens set expires_at = now() - interval '1 minute' where used_at is null` as never)
    expect(await resetPasswordWithToken(expired.token, 'whatever-pass')).toBeNull()
  })
})

describeDb('membership', () => {
  it('changes roles within the account only, never touching the owner', async () => {
    const { user: owner, account } = await createAccount()
    const agent = await addMember(account.id, 'agent')
    const outsider = await createAccount()

    await setMemberRole(owner.id, agent.user.id, 'admin')
    expect((await db.select().from(profiles).where(eq(profiles.userId, agent.user.id)))[0].accountRole).toBe('admin')
    await expect(setMemberRole(agent.user.id, owner.id, 'viewer')).rejects.toMatchObject({ status: 400 })
    await expect(setMemberRole(owner.id, outsider.user.id, 'viewer')).rejects.toMatchObject({ status: 403 })
    await expect(setMemberRole(owner.id, agent.user.id, 'owner')).rejects.toMatchObject({ status: 400 })
    const viewer = await addMember(account.id, 'viewer')
    await expect(setMemberRole(viewer.user.id, agent.user.id, 'viewer')).rejects.toMatchObject({ status: 403 })
  })

  it('removes a member into a fresh personal account', async () => {
    const { user: owner, account } = await createAccount()
    const agent = await addMember(account.id, 'agent')
    const newAccountId = await removeMember(owner.id, agent.user.id)
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, agent.user.id))
    expect(p).toMatchObject({ accountId: newAccountId, accountRole: 'owner' })
    await expect(removeMember(owner.id, owner.id)).rejects.toMatchObject({ status: 400 })
  })

  it('transfers ownership atomically', async () => {
    const { user: owner, account } = await createAccount()
    const admin = await addMember(account.id, 'admin')
    await expect(transferOwnership(admin.user.id, owner.id)).rejects.toMatchObject({ status: 403 })
    await transferOwnership(owner.id, admin.user.id)
    const roles = await db.select({ userId: profiles.userId, role: profiles.accountRole }).from(profiles).where(eq(profiles.accountId, account.id))
    expect(roles).toEqual(expect.arrayContaining([
      { userId: owner.id, role: 'admin' },
      { userId: admin.user.id, role: 'owner' },
    ]))
    expect((await db.select().from(accounts).where(eq(accounts.id, account.id)))[0].ownerUserId).toBe(admin.user.id)
  })

  it('peeks and redeems an invitation exactly once, deleting the empty personal account', async () => {
    const { account } = await createAccount({ name: 'Team' })
    const { token, hash } = generateInviteToken()
    await db.insert(accountInvitations).values({
      accountId: account.id,
      tokenHash: hash,
      role: 'agent',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    expect(await peekInvitation(hashInviteToken(token))).toMatchObject({ ok: true, account_name: 'Team', role: 'agent' })
    expect(await peekInvitation(hashInviteToken('nope'))).toEqual({ ok: false, reason: 'not_found' })

    const joiner = await createAccount()
    expect(await redeemInvitation(joiner.user.id, hash)).toBe(account.id)
    expect((await db.select().from(profiles).where(eq(profiles.userId, joiner.user.id)))[0]).toMatchObject({
      accountId: account.id,
      accountRole: 'agent',
    })
    expect(await db.select().from(accounts).where(eq(accounts.id, joiner.account.id))).toHaveLength(0)
    expect(await peekInvitation(hash)).toEqual({ ok: false, reason: 'used' })
    await expect(redeemInvitation((await createAccount()).user.id, hash)).rejects.toMatchObject({ status: 400 })
  })

  it('refuses to redeem when the joiner’s own account holds data', async () => {
    const { account } = await createAccount()
    const { hash } = generateInviteToken()
    await db.insert(accountInvitations).values({
      accountId: account.id,
      tokenHash: hash,
      role: 'viewer',
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    const joiner = await createAccount()
    await createContact(joiner.account.id, joiner.user.id)
    await expect(redeemInvitation(joiner.user.id, hash)).rejects.toMatchObject({ status: 409 })
    expect(await db.select().from(contacts).where(eq(contacts.accountId, joiner.account.id))).toHaveLength(1)
    expect((await db.select().from(users).where(eq(users.id, joiner.user.id)))).toHaveLength(1)
  })
})
