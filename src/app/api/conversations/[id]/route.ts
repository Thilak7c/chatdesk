// src/app/api/conversations/[id]/route.ts

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { conversations, contacts } from "@/db/schema";
import { emitConversationEvent } from "@/lib/socket";
import { isAccountMember, notifyConversationAssigned } from "@/lib/conversations/assign";

const STATUSES = new Set(["open", "pending", "closed"]);

function toConversationJson(
  conv: typeof conversations.$inferSelect,
  contact: typeof contacts.$inferSelect | null,
) {
  return {
    id: conv.id,
    account_id: conv.accountId,
    contact_id: conv.contactId,
    status: conv.status,
    assigned_agent_id: conv.assignedAgentId,
    last_message_text: conv.lastMessageText,
    last_message_at: conv.lastMessageAt,
    unread_count: conv.unreadCount,
    ai_autoreply_disabled: conv.aiAutoreplyDisabled,
    ai_reply_count: conv.aiReplyCount,
    ai_handoff_summary: conv.aiHandoffSummary,
    created_at: conv.createdAt,
    updated_at: conv.updatedAt,
    contact: contact
      ? {
          id: contact.id,
          account_id: contact.accountId,
          phone: contact.phone,
          name: contact.name,
          email: contact.email,
          company: contact.company,
          avatar_url: contact.avatarUrl,
        }
      : null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    const row = await db
      .select({
        conversation: conversations,
        contact: contacts,
      })
      .from(conversations)
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .limit(1);

    if (!row[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(toConversationJson(row[0].conversation, row[0].contact));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/conversations/[id]
 *
 * Body: partial { status, assigned_agent_id, unread_count }
 *
 * Emits a conversation-event so every open tab picks up the change, and
 * notifies the new assignee when the assignment changes.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const body = await req.json();

    const patch: Partial<typeof conversations.$inferInsert> = {};
    if (typeof body.status === "string") {
      if (!STATUSES.has(body.status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      patch.status = body.status;
    }
    if ("assigned_agent_id" in body) {
      const assignee = body.assigned_agent_id ?? null;
      if (assignee !== null) {
        if (typeof assignee !== "string" || !(await isAccountMember(db, ctx.accountId, assignee))) {
          return NextResponse.json({ error: "Assignee is not a member of this account" }, { status: 400 });
        }
      }
      patch.assignedAgentId = assignee;
    }
    if (typeof body.unread_count === "number" && body.unread_count >= 0) {
      patch.unreadCount = Math.floor(body.unread_count);
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [previous] = await db
      .select({ assignedAgentId: conversations.assignedAgentId })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .limit(1);
    if (!previous) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updated = await db
      .update(conversations)
      .set(patch)
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .returning();

    if (!updated[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, updated[0].contactId),
    });

    if ("assignedAgentId" in patch) {
      await notifyConversationAssigned(db, {
        accountId: ctx.accountId,
        conversationId: id,
        contactId: updated[0].contactId,
        newAssigneeId: updated[0].assignedAgentId,
        previousAssigneeId: previous.assignedAgentId,
        actorUserId: ctx.userId,
      });
    }

    const json = toConversationJson(updated[0], contact ?? null);

    emitConversationEvent(ctx.accountId, { eventType: "UPDATE", new: json });

    return NextResponse.json(json);
  } catch (err) {
    return toErrorResponse(err);
  }
}