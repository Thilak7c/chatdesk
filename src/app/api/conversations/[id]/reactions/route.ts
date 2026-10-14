// src/app/api/conversations/[id]/reactions/route.ts

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { conversations, messageReactions } from "@/db/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    const conv = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)),
      columns: { id: true },
    });
    if (!conv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.conversationId, id));

    const out = rows.map((r) => ({
      id: r.id,
      message_id: r.messageId,
      conversation_id: r.conversationId,
      actor_type: r.actorType,
      actor_id: r.actorId,
      emoji: r.emoji,
      created_at: r.createdAt,
    }));

    return NextResponse.json({ reactions: out });
  } catch (err) {
    return toErrorResponse(err);
  }
}