// ============================================================
// Account membership: invitations, role changes, removal and
// ownership transfer.
//
// Each operation runs in one transaction and locks the profile rows
// it reasons about (SELECT ... FOR UPDATE), so two admins acting at
// once can't interleave into an inconsistent state (e.g. an account
// with zero owners). Authorization is enforced HERE, not just in the
// route: the caller's role and the target's account are re-read
// inside the transaction.
//
// Failures throw MembershipError with an HTTP-ish status the routes
// pass straight through.
// ============================================================

import { and, eq, gt, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { accountInvitations, accounts, profiles } from '@/db/schema';
import type { AccountRole } from '@/lib/auth/roles';

export class MembershipError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'MembershipError';
  }
}

async function lockProfile(tx: Tx, userId: string) {
  const [row] = await tx
    .select({
      userId: profiles.userId,
      accountId: profiles.accountId,
      role: profiles.accountRole,
      fullName: profiles.fullName,
      email: profiles.email,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');
  return row ?? null;
}

/** Caller must exist and hold one of `roles`; returns their profile. */
async function requireCaller(tx: Tx, callerId: string, roles: AccountRole[]) {
  const caller = await lockProfile(tx, callerId);
  if (!caller) throw new MembershipError('Caller has no account', 403);
  if (!roles.includes(caller.role)) {
    throw new MembershipError(
      roles.length === 1 && roles[0] === 'owner'
        ? 'Only the account owner can do this'
        : 'This action requires the admin role or higher',
      403,
    );
  }
  return caller;
}

/** Target must be a member of the caller's account. */
async function requireTargetInAccount(tx: Tx, targetId: string, accountId: string) {
  const target = await lockProfile(tx, targetId);
  if (!target) throw new MembershipError('Target user not found', 404);
  if (target.accountId !== accountId) {
    throw new MembershipError('Target user is not a member of your account', 403);
  }
  return target;
}

/** Change a member's role. Admin+; owner changes go through transferOwnership. */
export async function setMemberRole(
  callerId: string,
  targetId: string,
  newRole: AccountRole,
): Promise<void> {
  if (targetId === callerId) throw new MembershipError('Cannot change your own role', 400);
  if (newRole === 'owner') {
    throw new MembershipError('Use transfer-ownership to promote a member to owner', 400);
  }
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId, ['owner', 'admin']);
    const target = await requireTargetInAccount(tx, targetId, caller.accountId);
    if (target.role === 'owner') {
      throw new MembershipError('Use transfer-ownership to demote the owner', 400);
    }
    await tx.update(profiles).set({ accountRole: newRole }).where(eq(profiles.userId, targetId));
  });
}

/**
 * Remove a member from the caller's account. Admin+. The removed user
 * keeps their login and lands in a fresh personal account of their
 * own (as if they'd just signed up). Returns that new account's id.
 */
export async function removeMember(callerId: string, targetId: string): Promise<string> {
  if (targetId === callerId) {
    throw new MembershipError(
      'Cannot remove yourself; transfer ownership or leave the account instead',
      400,
    );
  }
  return db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId, ['owner', 'admin']);
    const target = await requireTargetInAccount(tx, targetId, caller.accountId);
    if (target.role === 'owner') {
      throw new MembershipError('Cannot remove the account owner; transfer ownership first', 400);
    }

    const [personal] = await tx
      .insert(accounts)
      .values({ name: target.fullName || target.email || 'My account', ownerUserId: targetId })
      .returning({ id: accounts.id });
    await tx
      .update(profiles)
      .set({ accountId: personal.id, accountRole: 'owner' })
      .where(eq(profiles.userId, targetId));
    return personal.id;
  });
}

/**
 * Hand the account to another member. Owner only. The old owner
 * becomes an admin; both role writes and the accounts.owner_user_id
 * pointer change in one transaction, so the account is never seen
 * with zero or two owners.
 */
export async function transferOwnership(callerId: string, newOwnerId: string): Promise<void> {
  if (newOwnerId === callerId) throw new MembershipError('You are already the owner', 400);
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId, ['owner']);
    await requireTargetInAccount(tx, newOwnerId, caller.accountId);

    await tx.update(profiles).set({ accountRole: 'admin' }).where(eq(profiles.userId, callerId));
    await tx.update(profiles).set({ accountRole: 'owner' }).where(eq(profiles.userId, newOwnerId));
    await tx
      .update(accounts)
      .set({ ownerUserId: newOwnerId })
      .where(eq(accounts.id, caller.accountId));
  });
}

export type InvitationPeek =
  | { ok: true; account_name: string; role: AccountRole; expires_at: string }
  | { ok: false; reason: 'not_found' | 'used' | 'expired' };

/** What the public /join page shows before sign-in. Never leaks more than this. */
export async function peekInvitation(tokenHash: string): Promise<InvitationPeek> {
  const [inv] = await db
    .select({
      role: accountInvitations.role,
      expiresAt: accountInvitations.expiresAt,
      acceptedAt: accountInvitations.acceptedAt,
      accountName: accounts.name,
    })
    .from(accountInvitations)
    .innerJoin(accounts, eq(accounts.id, accountInvitations.accountId))
    .where(eq(accountInvitations.tokenHash, tokenHash))
    .limit(1);
  if (!inv) return { ok: false, reason: 'not_found' };
  if (inv.acceptedAt) return { ok: false, reason: 'used' };
  if (inv.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    account_name: inv.accountName,
    role: inv.role,
    expires_at: inv.expiresAt.toISOString(),
  };
}

// Tables whose rows mean "this account has real data". Joining another
// account would orphan them, so redeem refuses.
const DATA_TABLES = [
  'contacts',
  'conversations',
  'broadcasts',
  'automations',
  'flows',
  'pipelines',
  'message_templates',
  'tags',
  'custom_fields',
  'contact_notes',
  'whatsapp_config',
] as const;

/**
 * Accept an invitation: move the caller from their personal account
 * into the inviter's, with the invited role. Returns the joined
 * account id.
 *
 * Only allowed when the caller is the sole owner of an EMPTY personal
 * account — anything else (already in a shared account, or their
 * account holds data) would silently strand people or data, so the
 * answer is "sign up with a different email".
 */
export async function redeemInvitation(callerId: string, tokenHash: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.tokenHash, tokenHash))
      .for('update');
    if (!inv) throw new MembershipError('Invitation not found', 400);
    if (inv.acceptedAt) throw new MembershipError('Invitation has already been redeemed', 400);
    if (inv.expiresAt.getTime() <= Date.now()) {
      throw new MembershipError('Invitation has expired', 400);
    }

    const caller = await lockProfile(tx, callerId);
    if (!caller) throw new MembershipError('Caller has no profile', 401);
    if (caller.accountId === inv.accountId) {
      throw new MembershipError('You are already a member of this account', 409);
    }

    const [oldAccount] = await tx
      .select({ ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, caller.accountId))
      .for('update');
    if (!oldAccount || oldAccount.ownerUserId !== callerId) {
      throw new MembershipError(
        'You are already in a shared account; sign up with a different email to join this one',
        409,
      );
    }

    const probes = DATA_TABLES.map(
      (t) => sql`select 1 from ${sql.identifier(t)} where account_id = ${caller.accountId}`,
    );
    const hasData = await tx.execute(
      sql`select exists (${sql.join(probes, sql` union all `)}) as has_data`,
    );
    if ((hasData.rows[0] as { has_data: boolean } | undefined)?.has_data) {
      throw new MembershipError(
        'Your account already contains data; sign up with a different email to join this one',
        409,
      );
    }

    // Move the profile first so deleting the old account doesn't
    // cascade onto it.
    await tx
      .update(profiles)
      .set({ accountId: inv.accountId, accountRole: inv.role })
      .where(eq(profiles.userId, callerId));
    await tx
      .update(accountInvitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: callerId })
      .where(eq(accountInvitations.id, inv.id));
    // Housekeeping: the personal account is empty (checked above), and
    // other users' profiles can't point at it (caller was sole owner of
    // a non-shared account), so nothing else cascades.
    await tx.delete(accounts).where(eq(accounts.id, caller.accountId));

    return inv.accountId;
  });
}

/** Live (unaccepted, unexpired) invitations for an account, newest first. */
export async function listPendingInvitations(accountId: string) {
  return db
    .select({
      id: accountInvitations.id,
      role: accountInvitations.role,
      label: accountInvitations.label,
      createdByUserId: accountInvitations.createdByUserId,
      createdAt: accountInvitations.createdAt,
      expiresAt: accountInvitations.expiresAt,
    })
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, accountId),
        sql`${accountInvitations.acceptedAt} is null`,
        gt(accountInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(sql`${accountInvitations.createdAt} desc`);
}
