// src/app/api/deals/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, deals, pipelines, pipelineStages, profiles } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["open", "won", "lost"];

type RouteContext = { params: Promise<{ id: string }> };

function toDeal(row: typeof deals.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    pipeline_id: row.pipelineId,
    stage_id: row.stageId,
    contact_id: row.contactId,
    conversation_id: row.conversationId,
    assigned_to: row.assignedTo,
    title: row.title,
    value: Number(row.value),
    currency: row.currency,
    notes: row.notes,
    expected_close_date: row.expectedCloseDate,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
      .limit(1);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const patch: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };

    if ("title" in body) {
      const title = str(body.title);
      if (!title) {
        return NextResponse.json({ error: "Title is required" }, { status: 400 });
      }
      patch.title = title;
    }

    if ("value" in body) {
      const n = Number(body.value);
      patch.value = String(Number.isFinite(n) ? n : 0);
    }

    if ("currency" in body) {
      patch.currency = str(body.currency) ?? "USD";
    }

    if ("notes" in body) {
      patch.notes = str(body.notes);
    }

    if ("expected_close_date" in body) {
      const d = str(body.expected_close_date);
      patch.expectedCloseDate = d && DATE_RE.test(d) ? d : null;
    }

    if ("status" in body) {
      const status = str(body.status);
      if (!status || !STATUSES.includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      patch.status = status;
    }

    if ("contact_id" in body) {
      const contactId = str(body.contact_id);
      if (!contactId || !UUID_RE.test(contactId)) {
        return NextResponse.json({ error: "Invalid contact" }, { status: 400 });
      }
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1);
      if (!contact) {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }
      patch.contactId = contactId;
    }

    if ("assigned_to" in body) {
      const assignedTo = str(body.assigned_to);
      if (assignedTo) {
        if (!UUID_RE.test(assignedTo)) {
          return NextResponse.json({ error: "Invalid assignee" }, { status: 400 });
        }
        const [profile] = await db
          .select({ id: profiles.id })
          .from(profiles)
          .where(and(eq(profiles.id, assignedTo), eq(profiles.accountId, ctx.accountId)))
          .limit(1);
        if (!profile) {
          return NextResponse.json({ error: "Assignee not found" }, { status: 404 });
        }
      }
      patch.assignedTo = assignedTo;
    }

    const nextPipelineId = str(body.pipeline_id) ?? existing.pipelineId;
    const nextStageId = str(body.stage_id);

    if (nextStageId || nextPipelineId !== existing.pipelineId) {
      const stageToCheck = nextStageId ?? existing.stageId;
      if (
        !UUID_RE.test(nextPipelineId) ||
        !UUID_RE.test(stageToCheck) ||
        (nextPipelineId !== existing.pipelineId && !nextStageId)
      ) {
        return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
      }
      const [stage] = await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
        .where(
          and(
            eq(pipelineStages.id, stageToCheck),
            eq(pipelineStages.pipelineId, nextPipelineId),
            eq(pipelines.accountId, ctx.accountId)
          )
        )
        .limit(1);
      if (!stage) {
        return NextResponse.json({ error: "Stage not found" }, { status: 404 });
      }
      patch.pipelineId = nextPipelineId;
      patch.stageId = stageToCheck;
    }

    const [row] = await db
      .update(deals)
      .set(patch)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
      .returning();

    return NextResponse.json({ deal: toDeal(row) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const deleted = await db
      .delete(deals)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
      .returning({ id: deals.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}