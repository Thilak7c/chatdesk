// ============================================================
// Database-backed login sessions.
//
// The browser holds an opaque random token in an httpOnly cookie;
// the `sessions` table stores only its SHA-256 hash. Validating a
// request = hash the cookie, look the row up, check expiry. Signing
// out (one device or all) = deleting rows, which takes effect on the
// very next request — unlike a JWT, which stays valid until expiry.
//
// Sessions slide: any request more than SESSION_REFRESH_MS after the
// last refresh pushes `expires_at` out another SESSION_TTL_MS, so an
// active user is never logged out mid-week while an abandoned
// session dies on schedule.
// ============================================================

import { createHash, randomBytes } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';

import { db } from '@/db';
import { SESSION_COOKIE } from './session-cookie';
import { sessions, users } from '@/db/schema';

export { SESSION_COOKIE };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
}

export interface Session {
  id: string;
  user: SessionUser;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    // Plain-HTTP localhost needs a non-Secure cookie; anything
    // deployed is expected to sit behind TLS.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

/**
 * Create a session row for `userId` and set the cookie. Call from a
 * Route Handler or Server Action (cookies are read-only elsewhere).
 */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const h = await headers();

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: h.get('user-agent')?.slice(0, 512) ?? null,
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

/**
 * Resolve the current request's session, or null. Memoised per
 * request, so calling it from several helpers costs one query.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const now = new Date();
  const [row] = await db
    .select({
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .limit(1);

  if (!row) return null;

  let expiresAt = row.expiresAt;
  if (now.getTime() - row.lastSeenAt.getTime() > SESSION_REFRESH_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(sessions.id, row.id));
    try {
      // Only succeeds in a Route Handler / Server Action; in a
      // Server Component the DB expiry still slides and the cookie
      // is re-issued on the next mutating request.
      store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    } catch {
      /* read-only cookie store */
    }
  }

  return { id: row.id, user: { id: row.userId, email: row.email }, expiresAt };
});

/** Delete the current session row and clear the cookie. */
export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
}

/** Sign a user out everywhere — every device, including this one. */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Housekeeping — drop expired rows. Safe to call from a cron. */
export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
