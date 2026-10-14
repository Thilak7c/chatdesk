// src/app/api/pipelines/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelines } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

function toPipeline(row: typeof pipelines.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    created_at: row.createdAt,
  };
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("admin");
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

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (name.length > 100) {
      return NextResponse.json({ error: "Name is too long" }, { status: 400 });
    }

    const [row] = await db
      .update(pipelines)
      .set({ name })
      .where(and(eq(pipelines.id, id), eq(pipelines.accountId, ctx.accountId)))
      .returning();

    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ pipeline: toPipeline(row) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const deleted = await db
      .delete(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.accountId, ctx.accountId)))
      .returning({ id: pipelines.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}