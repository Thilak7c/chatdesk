// src/app/api/contacts/[id]/conversation/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return NextResponse.json({ conversation: null });
    }

    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.contactId, id),
          eq(conversations.accountId, ctx.accountId)
        )
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);

    if (!row) {
      return NextResponse.json({ conversation: null });
    }

    return NextResponse.json({
      conversation: {
        id: row.id,
        user_id: row.userId,
        account_id: row.accountId,
        contact_id: row.contactId,
        status: row.status,
        assigned_agent_id: row.assignedAgentId,
        last_message_text: row.lastMessageText,
        last_message_at: row.lastMessageAt,
        unread_count: row.unreadCount,
        ai_autoreply_disabled: row.aiAutoreplyDisabled,
        ai_reply_count: row.aiReplyCount,
        ai_handoff_summary: row.aiHandoffSummary,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}