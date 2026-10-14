// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the account and/or set its    Admin+.
//           default currency.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { accounts } from "@/db/schema";
import { CURRENCIES } from "@/lib/currency";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: {
        id: ctx.account.id,
        name: ctx.account.name,
        default_currency: ctx.account.defaultCurrency,
      },
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; default_currency?: unknown }
      | null;
    const patch: { name?: string; defaultCurrency?: string } = {};

    if (body && "name" in body) {
      if (typeof body.name !== "string") {
        return NextResponse.json(
          { error: "'name' must be a string" },
          { status: 400 },
        );
      }
      const name = body.name.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: "Account name cannot be empty" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    if (body && "default_currency" in body) {
      const code = body.default_currency;
      if (typeof code !== "string" || !CURRENCIES.some((c) => c.code === code)) {
        return NextResponse.json(
          { error: "'default_currency' must be a supported currency code" },
          { status: 400 },
        );
      }
      patch.defaultCurrency = code;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "Provide 'name' and/or 'default_currency'" },
        { status: 400 },
      );
    }

    const [data] = await db
      .update(accounts)
      .set(patch)
      .where(eq(accounts.id, ctx.accountId))
      .returning({
        id: accounts.id,
        name: accounts.name,
        default_currency: accounts.defaultCurrency,
      });

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
