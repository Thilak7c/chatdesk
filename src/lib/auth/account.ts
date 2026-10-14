// src/lib/auth/account.ts

// ============================================================
// Server-side account context — for API routes and server
// components. Resolves session → user → profile → account in one
// query and verifies role on demand.
//
// There is no row-level security in the database: this context is
// the tenancy boundary. Every query a route makes MUST be filtered
// by `ctx.accountId`.
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.userId  — the session user's id
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return toErrorResponse(err);
//   }
// ============================================================

import { cache } from "react";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { profiles, accounts } from "@/db/schema";
import { getSession } from "./session";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Session user id. Always defined when this resolves. */
  userId: string;
  /** Session user's email. */
  email: string;
  /** Current session row id — lets callers keep it on "sign out others". */
  sessionId: string;
  /** Caller's profiles.id (deals.assigned_to points here). */
  profileId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta. */
  account: { id: string; name: string; defaultCurrency: string };
}

/**
 * Resolve the caller's user + account + role. Memoised per request.
 *
 * Throws `UnauthorizedError` if there's no valid session.
 * Throws `ForbiddenError` if the user has no profile/account.
 */
export const getCurrentAccount = cache(async (): Promise<AccountContext> => {
  const session = await getSession();
  if (!session) {
    throw new UnauthorizedError();
  }
  const userId = session.user.id;

  const [row] = await db
    .select({
      profileId: profiles.id,
      accountRole: profiles.accountRole,
      accountId: accounts.id,
      accountName: accounts.name,
      defaultCurrency: accounts.defaultCurrency,
    })
    .from(profiles)
    .innerJoin(accounts, eq(accounts.id, profiles.accountId))
    .where(eq(profiles.userId, userId))
    .limit(1);

  if (!row) {
    console.error("[getCurrentAccount] no profile/account for user", userId);
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(row.accountRole)) {
    throw new ForbiddenError(`Unknown account role: ${row.accountRole}`);
  }

  return {
    userId,
    email: session.user.email,
    sessionId: session.id,
    profileId: row.profileId,
    accountId: row.accountId,
    role: row.accountRole,
    account: {
      id: row.accountId,
      name: row.accountName,
      defaultCurrency: row.defaultCurrency,
    },
  };
});

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
