// src/app/api/pipelines/[id]/deals/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, deals, pipelines, profiles } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

function toContact(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    phone: row.phone,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toProfile(row: typeof profiles.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    account_role: row.accountRole,
    full_name: row.fullName,
    email: row.email,
    avatar_url: row.avatarUrl,
    role: row.role,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

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

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [pipeline] = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.accountId, ctx.accountId)))
      .limit(1);

    if (!pipeline) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select({ deal: deals, contact: contacts, assignee: profiles })
      .from(deals)
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .leftJoin(profiles, eq(profiles.id, deals.assignedTo))
      .where(eq(deals.pipelineId, id))
      .orderBy(desc(deals.createdAt));

    return NextResponse.json({
      deals: rows.map((r) => ({
        ...toDeal(r.deal),
        contact: r.contact ? toContact(r.contact) : null,
        assignee: r.assignee ? toProfile(r.assignee) : null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}