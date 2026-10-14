// src/app/api/presence/touch/route.ts

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { memberPresence } from "@/db/schema";
import { emitPresenceEvent } from "@/lib/socket";

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const { status } = await req.json();
  if (status !== "online" && status !== "away") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }


  const lastSeenAt = new Date();

  await db
    .insert(memberPresence)
    .values({
      userId: ctx.userId,
      accountId: ctx.accountId,
      status,
      lastSeenAt,
    })
    .onConflictDoUpdate({
      target: memberPresence.userId,
      set: { status, lastSeenAt, accountId: ctx.accountId },
    });

  emitPresenceEvent(ctx.accountId, {
    eventType: "UPDATE",
    new: {
      user_id: ctx.userId,
      status,
      last_seen_at: lastSeenAt.toISOString(),
    },
  });

  return NextResponse.json({ ok: true });
}