// src/app/api/pipelines/[id]/stages/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelines, pipelineStages } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_COLOR = "#3b82f6";

type RouteContext = { params: Promise<{ id: string }> };

function toStage(row: typeof pipelineStages.$inferSelect) {
  return {
    id: row.id,
    pipeline_id: row.pipelineId,
    name: row.name,
    color: row.color,
    position: row.position,
    created_at: row.createdAt,
  };
}

async function ownsPipeline(pipelineId: string, accountId: string) {
  if (!UUID_RE.test(pipelineId)) return false;
  const [row] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, accountId)))
    .limit(1);
  return !!row;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    if (!(await ownsPipeline(id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, id))
      .orderBy(asc(pipelineStages.position));

    return NextResponse.json({ stages: rows.map(toStage) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;

    if (!(await ownsPipeline(id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

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
    const color =
      typeof body.color === "string" && body.color.trim()
        ? body.color.trim()
        : DEFAULT_COLOR;
    const position = Number.isInteger(body.position) ? (body.position as number) : 0;

    const [row] = await db
      .insert(pipelineStages)
      .values({ pipelineId: id, name, color, position })
      .returning();

    return NextResponse.json({ stage: toStage(row) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;

    if (!(await ownsPipeline(id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let body: { stages?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!Array.isArray(body.stages) || body.stages.length === 0) {
      return NextResponse.json({ error: "Stages are required" }, { status: 400 });
    }

    const updates: { id: string; name: string; color: string; position: number }[] = [];
    for (const item of body.stages) {
      const raw = (item ?? {}) as Record<string, unknown>;
      const stageId = typeof raw.id === "string" ? raw.id : "";
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      const color =
        typeof raw.color === "string" && raw.color.trim()
          ? raw.color.trim()
          : DEFAULT_COLOR;
      if (!UUID_RE.test(stageId) || !name || !Number.isInteger(raw.position)) {
        return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
      }
      updates.push({ id: stageId, name, color, position: raw.position as number });
    }

    await db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(pipelineStages)
          .set({ name: u.name, color: u.color, position: u.position })
          .where(
            and(eq(pipelineStages.id, u.id), eq(pipelineStages.pipelineId, id))
          );
      }
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}