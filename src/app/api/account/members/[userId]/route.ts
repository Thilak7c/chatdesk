// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// Both delegate to src/lib/account/membership.ts, which re-checks
// authorization inside a transaction: caller must be admin+, target
// must be in caller's account, target can't be the owner, can't be
// self.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import {
  MembershipError,
  removeMember,
  setMemberRole,
} from "@/lib/account/membership";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function membershipErrorResponse(err: unknown): NextResponse {
  if (err instanceof MembershipError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return toErrorResponse(err);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown }
      | null;
    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }

    await setMemberRole(ctx.userId, userId, role);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return membershipErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    const newPersonalAccountId = await removeMember(ctx.userId, userId);
    return NextResponse.json({ ok: true, newPersonalAccountId });
  } catch (err) {
    return membershipErrorResponse(err);
  }
}
