// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Only the read side lives here: a public-API caller has no login
// session, so the key hash itself is what establishes the account.
// The management side (list / create / revoke) runs in the dashboard
// under a real session in /api/account/api-keys.
// ============================================================

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, apiKeys } from '@/db/schema';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no
 * row matches, or if the matching row is revoked or expired — so
 * callers never have to re-check liveness.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  let row;
  try {
    [row] = await db
      .select({
        id: apiKeys.id,
        accountId: apiKeys.accountId,
        createdBy: apiKeys.createdBy,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);
  } catch (err) {
    console.error('[api-keys/store] lookup error:', (err as Error).message);
    return null;
  }
  if (!row) return null;

  // Liveness checks in JS rather than SQL so the failure modes are
  // explicit and the index stays a simple equality lookup.
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  return {
    id: row.id,
    account_id: row.accountId,
    created_by: row.createdBy,
    name: row.name,
    scopes: row.scopes,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: null,
  };
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` can echo
 * it. The key already proved account membership.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  const [row] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth
 * path — a failed update just means the "last used" column lags;
 * it must never fail the request the caller is actually making.
 */
export function touchLastUsed(id: string): void {
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .catch((err: Error) => {
      console.warn('[api-keys/store] last_used_at bump failed:', err.message);
    });
}
