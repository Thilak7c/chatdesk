// src/app/api/automations/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { automations } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTemplate } from "@/lib/automations/templates";
import { insertSteps, type BuilderStepInput } from "@/lib/automations/steps-tree";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "@/lib/automations/validate";

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

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select()
      .from(automations)
      .where(eq(automations.accountId, ctx.accountId))
      .orderBy(desc(automations.createdAt));

    return NextResponse.json({ automations: rows.map(toApiAutomation) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");

    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { name, description, trigger_type, trigger_config, is_active, steps, template } = body;

    let effectiveSteps: BuilderStepInput[] | undefined = steps;
    let effectiveName = name;
    let effectiveDescription = description;
    let effectiveTriggerType = trigger_type;
    let effectiveTriggerConfig = trigger_config;

    if (template && (!steps || steps.length === 0)) {
      const t = getTemplate(template);
      if (t) {
        effectiveName = effectiveName ?? t.name;
        effectiveDescription = effectiveDescription ?? t.description;
        effectiveTriggerType = effectiveTriggerType ?? t.trigger_type;
        effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config;
        effectiveSteps = t.steps as unknown as BuilderStepInput[];
      }
    }

    if (!effectiveName || !effectiveTriggerType) {
      return NextResponse.json(
        { error: "name and trigger_type are required" },
        { status: 400 },
      );
    }

    if (is_active) {
      const issues = [
        ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
        ),
      ];
      if (issues.length > 0) {
        return NextResponse.json(
          { error: "Cannot activate automation with invalid configuration", issues },
          { status: 400 },
        );
      }
    }

    const [created] = await db
      .insert(automations)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name: effectiveName,
        description: effectiveDescription ?? null,
        triggerType: effectiveTriggerType,
        triggerConfig: effectiveTriggerConfig ?? {},
        isActive: !!is_active,
      })
      .returning();

    if (effectiveSteps && effectiveSteps.length > 0) {
      const err = await insertSteps(created.id, effectiveSteps);
      if (err) return NextResponse.json({ error: err }, { status: 500 });
    }

    return NextResponse.json({ automation: toApiAutomation(created) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}