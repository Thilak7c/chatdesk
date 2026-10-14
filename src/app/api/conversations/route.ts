// src/app/api/conversations/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { fetchConversations } from "@/lib/inbox/conversation-query";

/**
 * GET /api/conversations?status=&limit=&offset=
 *
 * Inbox list, newest activity first. Each conversation embeds its
 * contact (with tags, for the inbox's tag filter) and assignee.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireRole("viewer");

    const sp = req.nextUrl.searchParams;
    const status = sp.get("status");
    const limit = Math.min(Math.max(Number(sp.get("limit")) || 25, 1), 100);
    const offset = Math.max(Number(sp.get("offset")) || 0, 0);

    const statusFilter = status ? eq(conversations.status, status) : undefined;

    const [rows, countRows] = await Promise.all([
      fetchConversations(db, {
        accountId: ctx.accountId,
        where: [statusFilter],
        orderBy: [sql`${conversations.lastMessageAt} desc nulls last`],
        limit,
        offset,
      }),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversations)
        .where(and(eq(conversations.accountId, ctx.accountId), statusFilter)),
    ]);

    return NextResponse.json({ conversations: rows, total: countRows[0]?.count ?? 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
