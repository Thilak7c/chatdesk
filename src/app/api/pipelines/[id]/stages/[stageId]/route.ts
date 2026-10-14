// src/app/api/pipelines/[id]/stages/[stageId]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deals, pipelines, pipelineStages } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string; stageId: string }> };

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("admin");
    const { id, stageId } = await params;

    if (!UUID_RE.test(id) || !UUID_RE.test(stageId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [stage] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(
        and(
          eq(pipelineStages.id, stageId),
          eq(pipelineStages.pipelineId, id),
          eq(pipelines.accountId, ctx.accountId)
        )
      )
      .limit(1);

    if (!stage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deals)
      .where(eq(deals.stageId, stageId));

    if (count > 0) {
      return NextResponse.json(
        { error: "Stage still has deals" },
        { status: 409 }
      );
    }

    await db.delete(pipelineStages).where(eq(pipelineStages.id, stageId));

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}