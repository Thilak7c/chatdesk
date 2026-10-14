// src/app/api/pipeline-stages/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { pipelines, pipelineStages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        pipelineId: pipelineStages.pipelineId,
        position: pipelineStages.position,
      })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(pipelineStages.position);

    const stages = rows.map((r) => ({
      id: r.id,
      name: r.name,
      pipeline_id: r.pipelineId,
      position: r.position,
    }));

    return NextResponse.json({ stages });
  } catch (err) {
    return toErrorResponse(err);
  }
}