// src/app/api/deals/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, deals, pipelines, pipelineStages, profiles } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole("agent");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const title = str(body.title);
    const contactId = str(body.contact_id);
    const pipelineId = str(body.pipeline_id);
    const stageId = str(body.stage_id);
    const assignedTo = str(body.assigned_to);

    if (!title || !contactId || !pipelineId || !stageId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if (
      !UUID_RE.test(contactId) ||
      !UUID_RE.test(pipelineId) ||
      !UUID_RE.test(stageId) ||
      (assignedTo && !UUID_RE.test(assignedTo))
    ) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const [stage] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(
        and(
          eq(pipelineStages.id, stageId),
          eq(pipelineStages.pipelineId, pipelineId),
          eq(pipelines.accountId, ctx.accountId)
        )
      )
      .limit(1);
    if (!stage) {
      return NextResponse.json({ error: "Stage not found" }, { status: 404 });
    }

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1);
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    if (assignedTo) {
      const [profile] = await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(and(eq(profiles.id, assignedTo), eq(profiles.accountId, ctx.accountId)))
        .limit(1);
      if (!profile) {
        return NextResponse.json({ error: "Assignee not found" }, { status: 404 });
      }
    }

    const numericValue = Number(body.value);
    const closeDate = str(body.expected_close_date);

    const [row] = await db
      .insert(deals)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        pipelineId,
        stageId,
        contactId,
        assignedTo,
        title,
        value: String(Number.isFinite(numericValue) ? numericValue : 0),
        currency: str(body.currency) ?? "USD",
        notes: str(body.notes),
        expectedCloseDate: closeDate && DATE_RE.test(closeDate) ? closeDate : null,
        status: "open",
      })
      .returning();

    return NextResponse.json({ deal: toDeal(row) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}