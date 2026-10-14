// src/app/api/conversations/[id]/messages/route.ts

import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    // Ownership check first — a conversation from another account should
    // 404, not leak its messages.
    const conv = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)),
      columns: { id: true },
    });
    if (!conv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    // Drizzle returns camelCase JS keys; the frontend `Message` type is
    // snake_case (same convention as /api/account/me's explicit mapping),
    // so translate here rather than leaking Drizzle's naming into the UI.
    const out = rows.map((m) => ({
      id: m.id,
      conversation_id: m.conversationId,
      sender_type: m.senderType,
      sender_id: m.senderId,
      content_type: m.contentType,
      content_text: m.contentText,
      media_url: m.mediaUrl,
      media_type: m.mediaType,
      template_name: m.templateName,
      message_id: m.messageId,
      status: m.status,
      reply_to_message_id: m.replyToMessageId,
      interactive_reply_id: m.interactiveReplyId,
      interactive_payload: m.interactivePayload,
      ai_generated: m.aiGenerated,
      created_at: m.createdAt,
    }));

    return NextResponse.json({ messages: out });
  } catch (err) {
    return toErrorResponse(err);
  }
}