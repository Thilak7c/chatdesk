// ============================================================
// User accounts: credentials, signup provisioning, password reset.
// ============================================================

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  passwordResetTokens,
  profiles,
  sessions,
  users,
} from '@/db/schema';
import { hashToken } from './session';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

const BCRYPT_ROUNDS = 12;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// Compared against when the email is unknown, so a login attempt for
// a non-existent user costs the same bcrypt time as a real one and
// response timing doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', BCRYPT_ROUNDS);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Returns the user id when the credentials are valid, else null. */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizeEmail(email)),
    columns: { id: true, passwordHash: true },
  });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && user?.passwordHash ? user.id : null;
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email already in use');
    this.name = 'EmailTakenError';
  }
}

/**
 * Create a user plus the personal account they own and their
 * profile (role `owner`) in one transaction. Joining someone else's
 * account happens afterwards by redeeming an invitation.
 */
export async function createUserWithPersonalAccount(params: {
  email: string;
  password: string;
  fullName: string;
}): Promise<{ userId: string; accountId: string }> {
  const email = normalizeEmail(params.email);
  const fullName = params.fullName.trim();
  const passwordHash = await hashPassword(params.password);

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email, passwordHash })
        .returning({ id: users.id });

      const [account] = await tx
        .insert(accounts)
        .values({ name: fullName || email, ownerUserId: user.id })
        .returning({ id: accounts.id });

      await tx.insert(profiles).values({
        userId: user.id,
        accountId: account.id,
        accountRole: 'owner',
        fullName,
        email,
      });

      return { userId: user.id, accountId: account.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailTakenError();
    throw err;
  }
}

/**
 * Change a user's password. Signs out every *other* device — a
 * password change is usually a response to a suspected compromise.
 */
export async function changePassword(
  userId: string,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx
      .delete(sessions)
      .where(
        keepSessionId
          ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
          : eq(sessions.userId, userId),
      );
  });
}

/**
 * Issue a single-use reset token for `email`. Returns the raw token
 * (to be emailed) or null when no such user exists — callers must
 * respond identically either way so the endpoint can't be used to
 * probe for registered emails.
 */
export async function createPasswordResetToken(
  email: string,
): Promise<{ token: string; email: string } | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizeEmail(email)),
    columns: { id: true, email: true },
  });
  if (!user) return null;

  const token = randomBytes(32).toString('base64url');
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });
  return { token, email: user.email };
}

/**
 * Consume a reset token and set a new password. Every session for
 * the user is revoked. Returns the user id, or null if the token is
 * unknown, expired or already used.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
): Promise<string | null> {
  const passwordHash = await hashPassword(newPassword);
  return db.transaction(async (tx) => {
    // Claiming the row with UPDATE ... RETURNING makes the token
    // single-use even under concurrent submissions.
    const [claimed] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    if (!claimed) return null;

    await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, claimed.userId));
    await tx.delete(sessions).where(eq(sessions.userId, claimed.userId));
    return claimed.userId;
  });
}
