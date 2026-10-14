// ============================================================
// POST /api/invitations/[token]/redeem
//
// Authenticated. Caller atomically moves from their personal
// account (created at signup) to the inviter's account with the
// invite's role. Heavy lifting lives in redeemInvitation()
// (src/lib/account/membership.ts).
//
// Refusal contract
//   - 401 — not signed in
//   - 400 — invitation not found / used / expired
//   - 409 — caller's account already has data, or they're already
//           in this or another shared account
//
// Rate limit (per IP) is tighter than peek — a successful redeem
// changes data, and the data-loss guard makes brute-force retries
// pointless past a few attempts.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { getSession } from "@/lib/auth/session";
import { MembershipError, redeemInvitation } from "@/lib/account/membership";
import {
  checkRateLimit,
  clientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`redeem:${clientIp(request)}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: "Missing invitation token" },
      { status: 400 },
    );
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const accountId = await redeemInvitation(session.user.id, hashInviteToken(token));
    return NextResponse.json({ ok: true, accountId });
  } catch (err) {
    if (err instanceof MembershipError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[redeem] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to redeem invitation" },
      { status: 500 },
    );
  }
}
