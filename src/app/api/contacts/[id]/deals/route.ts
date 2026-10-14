// src/app/api/contacts/[id]/deals/route.ts

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { contacts, deals, pipelineStages } from "@/db/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)),
      columns: { id: true },
    });
    if (!contact) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select({ deal: deals, stage: pipelineStages })
      .from(deals)
      .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .where(and(eq(deals.contactId, id), eq(deals.accountId, ctx.accountId)))
      .orderBy(desc(deals.createdAt));

    const out = rows.map((r) => ({
      id: r.deal.id,
      account_id: r.deal.accountId,
      pipeline_id: r.deal.pipelineId,
      stage_id: r.deal.stageId,
      contact_id: r.deal.contactId,
      conversation_id: r.deal.conversationId,
      assigned_to: r.deal.assignedTo,
      title: r.deal.title,
      value: r.deal.value,
      currency: r.deal.currency,
      notes: r.deal.notes,
      expected_close_date: r.deal.expectedCloseDate,
      status: r.deal.status,
      created_at: r.deal.createdAt,
      updated_at: r.deal.updatedAt,
      stage: r.stage
        ? {
            id: r.stage.id,
            name: r.stage.name,
            position: r.stage.position,
            color: r.stage.color,
          }
        : null,
    }));

    return NextResponse.json({ deals: out });
  } catch (err) {
    return toErrorResponse(err);
  }
}