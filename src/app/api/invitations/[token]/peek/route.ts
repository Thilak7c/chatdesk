// ============================================================
// GET /api/invitations/[token]/peek
//
// Public — no auth required. Lets the /join/<token> page render
// "You're being invited to <Account> as <Role>" before the
// visitor signs up or signs in.
//
// Security model
//   - Token is in the URL path, not the query, so it doesn't
//     show up in standard access-log "referer" fields the way a
//     `?token=` would.
//   - The plaintext token never crosses the DB boundary — we
//     hash it first and look up by `token_hash`.
//   - peekInvitation() returns a fixed-shape payload that never
//     leaks columns beyond what the join page renders.
//   - Per-IP rate limit pinches brute-force enumeration of
//     tokens. With 256 bits of entropy the enumeration risk is
//     theoretical, but rate limiting is cheap insurance.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { peekInvitation } from "@/lib/account/membership";
import {
  checkRateLimit,
  clientIp,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`peek:${clientIp(request)}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { ok: false, reason: "not_found" },
      { status: 404 },
    );
  }

  try {
    return NextResponse.json(await peekInvitation(hashInviteToken(token)));
  } catch (err) {
    console.error("[peek] error:", err);
    return NextResponse.json(
      { ok: false, reason: "server_error" },
      { status: 500 },
    );
  }
}
