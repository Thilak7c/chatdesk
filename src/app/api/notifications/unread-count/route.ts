// src/app/api/notifications/unread-count/route.ts

import { NextResponse } from "next/server";
import { and, eq, isNull, count } from "drizzle-orm";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { notifications } from "@/db/schema";

export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const rows = await db
    .select({ c: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, ctx.userId), eq(notifications.accountId, ctx.accountId), isNull(notifications.readAt)));

  return NextResponse.json({ count: rows[0]?.c ?? 0 });
}