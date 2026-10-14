// ============================================================
// POST /api/account/transfer-ownership
//
// Owner only. Atomically:
//   - demotes the current owner to 'admin'
//   - promotes the target member to 'owner'
//   - updates accounts.owner_user_id
//
// The transaction lives in src/lib/account/membership.ts.
//
// Why a separate endpoint instead of PATCH /members/[userId]?
//   The semantics differ: transfer demotes the current owner as
//   a side-effect and changes the owner_user_id pointer on
//   `accounts`. Making it explicit prevents the "I clicked the
//   role dropdown by mistake" failure mode where an admin would
//   silently hand their account away.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { MembershipError, transferOwnership } from "@/lib/account/membership";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function looksLikeUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");

    // Legitimate use is one click every few months at most; the cap
    // just bounds a script run in a loop.
    const limit = checkRateLimit(
      `admin:transferOwnership:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { newOwnerUserId?: unknown }
      | null;
    const newOwnerUserId = body?.newOwnerUserId;

    if (!looksLikeUuid(newOwnerUserId)) {
      return NextResponse.json(
        { error: "'newOwnerUserId' must be a valid UUID" },
        { status: 400 },
      );
    }

    await transferOwnership(ctx.userId, newOwnerUserId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof MembershipError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
