// src/app/api/broadcasts/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { broadcasts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const BROADCAST_STATUSES = new Set(["draft", "scheduled", "sending", "sent", "failed"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toApiBroadcast(b: typeof broadcasts.$inferSelect) {
  return {
    id: b.id,
    name: b.name,
    template_name: b.templateName,
    template_language: b.templateLanguage,
    template_variables: b.templateVariables,
    audience_filter: b.audienceFilter,
    scheduled_at: b.scheduledAt,
    status: b.status,
    total_recipients: b.totalRecipients,
    sent_count: b.sentCount,
    delivered_count: b.deliveredCount,
    read_count: b.readCount,
    replied_count: b.repliedCount,
    failed_count: b.failedCount,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [row] = await db
      .select()
      .from(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)));

    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ broadcast: toApiBroadcast(row) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

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
      .select()
      .from(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)));
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    // Only the lifecycle status is client-writable. The per-status
    // counters are maintained server-side from the recipient rows (see
    // src/lib/broadcasts/counters.ts); accepting them here would let a
    // client overwrite them.
    const updates: Partial<typeof broadcasts.$inferInsert> = {};
    if (body.status !== undefined) {
      if (!BROADCAST_STATUSES.has(body.status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      updates.status = body.status;
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ broadcast: toApiBroadcast(existing) });
    }

    const [updated] = await db
      .update(broadcasts)
      .set(updates)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)))
      .returning();

    return NextResponse.json({ broadcast: toApiBroadcast(updated) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [existing] = await db
      .select()
      .from(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)));
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.status === "sending") {
      return NextResponse.json({ error: "Cannot delete a broadcast that is sending" }, { status: 409 });
    }

    await db
      .delete(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)));

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}