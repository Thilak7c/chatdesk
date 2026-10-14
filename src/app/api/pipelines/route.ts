// src/app/api/pipelines/route.ts

import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelines, pipelineStages } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 },
  { name: "Qualified", color: "#eab308", position: 1 },
  { name: "Proposal Sent", color: "#f97316", position: 2 },
  { name: "Negotiation", color: "#8b5cf6", position: 3 },
  { name: "Won", color: "#22c55e", position: 4 },
];

function toPipeline(row: typeof pipelines.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    created_at: row.createdAt,
  };
}

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select()
      .from(pipelines)
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(asc(pipelines.createdAt));

    return NextResponse.json({ pipelines: rows.map(toPipeline) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole("admin");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (name.length > 100) {
      return NextResponse.json({ error: "Name is too long" }, { status: 400 });
    }

    const pipeline = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(pipelines)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name,
        })
        .returning();

      await tx.insert(pipelineStages).values(
        DEFAULT_STAGES.map((s) => ({
          pipelineId: created.id,
          name: s.name,
          color: s.color,
          position: s.position,
        }))
      );

      return created;
    });

    return NextResponse.json({ pipeline: toPipeline(pipeline) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}