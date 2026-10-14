// src/app/api/broadcasts/recipients/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { broadcastRecipients, broadcasts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isRecipientStatus, updateRecipient, type RecipientUpdate } from "@/lib/broadcasts/counters";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [existing] = await db
      .select({ recipientId: broadcastRecipients.id })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcastRecipients.broadcastId, broadcasts.id))
      .where(and(eq(broadcastRecipients.id, id), eq(broadcasts.accountId, ctx.accountId)));

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const updates: RecipientUpdate = {};

    if (body.status !== undefined) {
      if (!isRecipientStatus(body.status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      updates.status = body.status;
    }
    if (body.sent_at !== undefined) updates.sentAt = body.sent_at ? new Date(body.sent_at) : null;
    if (body.delivered_at !== undefined) updates.deliveredAt = body.delivered_at ? new Date(body.delivered_at) : null;
    if (body.read_at !== undefined) updates.readAt = body.read_at ? new Date(body.read_at) : null;
    if (body.replied_at !== undefined) updates.repliedAt = body.replied_at ? new Date(body.replied_at) : null;
    if (body.error_message !== undefined) updates.errorMessage = body.error_message;
    if (body.whatsapp_message_id !== undefined) updates.whatsappMessageId = body.whatsapp_message_id;

    // Applies the change and the parent broadcast's counter deltas atomically.
    await updateRecipient(db, id, updates);

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}