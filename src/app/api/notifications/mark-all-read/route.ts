// src/app/api/notifications/mark-all-read/route.ts

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { emitNotificationEvent } from "@/lib/socket";

export async function POST() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, ctx.userId), eq(notifications.accountId, ctx.accountId), isNull(notifications.readAt)),
    );

  // Other open tabs of this user refresh their badge.
  emitNotificationEvent(ctx.userId);
  return NextResponse.json({ success: true });
}