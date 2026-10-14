// src/app/api/notifications/route.ts

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

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
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, ctx.userId), eq(notifications.accountId, ctx.accountId)))
    .orderBy(desc(notifications.createdAt))
    .limit(100);

  const out = rows.map((n) => ({
    id: n.id,
    account_id: n.accountId,
    user_id: n.userId,
    type: n.type,
    conversation_id: n.conversationId,
    contact_id: n.contactId,
    actor_user_id: n.actorUserId,
    title: n.title,
    body: n.body,
    read_at: n.readAt,
    created_at: n.createdAt,
  }));

  return NextResponse.json({ notifications: out });
}