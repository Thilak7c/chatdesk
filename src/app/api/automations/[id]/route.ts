// src/app/api/automations/[id]/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { automations } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from "@/lib/automations/steps-tree";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "@/lib/automations/validate";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toApiAutomation(a: typeof automations.$inferSelect) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    trigger_type: a.triggerType,
    trigger_config: a.triggerConfig,
    is_active: a.isActive,
    execution_count: a.executionCount,
    last_executed_at: a.lastExecutedAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [automation] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)));

    if (!automation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const steps = await loadStepsTree(id);
    return NextResponse.json({ automation: toApiAutomation(automation), steps });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const [existing] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)));
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const update: Partial<typeof automations.$inferInsert> = { updatedAt: new Date() };
    if ("name" in body) update.name = body.name;
    if ("description" in body) update.description = body.description;
    if ("trigger_type" in body) update.triggerType = body.trigger_type;
    if ("trigger_config" in body) update.triggerConfig = body.trigger_config;
    if ("is_active" in body) update.isActive = body.is_active;

    const willBeActive =
      typeof update.isActive === "boolean" ? update.isActive : existing.isActive;
    if (willBeActive) {
      const mergedTriggerType = (update.triggerType ?? existing.triggerType) as string;
      const mergedTriggerConfig = update.triggerConfig ?? existing.triggerConfig;
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id);
      const issues = [
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(mergedSteps),
      ];
      if (issues.length > 0) {
        return NextResponse.json(
          {
            error: "Cannot keep automation active with invalid configuration",
            issues,
          },
          { status: 400 },
        );
      }
    }

    if (Object.keys(update).length > 1) {
      await db.update(automations).set(update).where(eq(automations.id, id));
    }

    if (Array.isArray(body.steps)) {
      const err = await replaceSteps(id, body.steps as BuilderStepInput[]);
      if (err) return NextResponse.json({ error: err }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [existing] = await db
      .select({ id: automations.id })
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)));
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db.delete(automations).where(eq(automations.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}