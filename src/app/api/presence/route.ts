// src/app/api/presence/route.ts

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { memberPresence } from "@/db/schema";

export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }


  const rows = await db.query.memberPresence.findMany({
    where: eq(memberPresence.accountId, ctx.accountId),
    columns: { userId: true, status: true, lastSeenAt: true },
  });

  return NextResponse.json(
    rows.map((r) => ({
      user_id: r.userId,
      status: r.status,
      last_seen_at: r.lastSeenAt,
    })),
  );
}