// src/app/api/flows/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { flows, flowNodes } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getFlowTemplate } from "@/lib/flows/templates";

function toApiFlow(f: typeof flows.$inferSelect) {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    status: f.status,
    trigger_type: f.triggerType,
    trigger_config: f.triggerConfig,
    entry_node_id: f.entryNodeId,
    fallback_policy: f.fallbackPolicy,
    execution_count: f.executionCount,
    last_executed_at: f.lastExecutedAt,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select()
      .from(flows)
      .where(eq(flows.accountId, ctx.accountId))
      .orderBy(desc(flows.createdAt));

    return NextResponse.json({ flows: rows.map(toApiFlow) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");

    const body = (await request.json().catch(() => null)) as
      | {
          name?: string;
          description?: string | null;
          trigger_type?: "keyword" | "first_inbound_message" | "manual";
          trigger_config?: Record<string, unknown>;
          template_slug?: string;
        }
      | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // -------- Template clone path --------
    if (body.template_slug) {
      const template = getFlowTemplate(body.template_slug);
      if (!template) {
        return NextResponse.json(
          { error: `Unknown template_slug "${body.template_slug}"` },
          { status: 400 },
        );
      }

      const [flow] = await db
        .insert(flows)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name: body.name?.trim() || template.name,
          description: template.description,
          status: "draft",
          triggerType: template.trigger_type,
          triggerConfig: template.trigger_config,
          entryNodeId: template.entry_node_id,
        })
        .returning();

      if (!flow) {
        return NextResponse.json({ error: "flow insert failed" }, { status: 500 });
      }

      if (template.nodes.length > 0) {
        try {
          await db.insert(flowNodes).values(
            template.nodes.map((n) => ({
              flowId: flow.id,
              nodeKey: n.node_key,
              nodeType: n.node_type,
              config: n.config,
            })),
          );
        } catch (err) {
          await db.delete(flows).where(eq(flows.id, flow.id));
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "node insert failed" },
            { status: 500 },
          );
        }
      }
      return NextResponse.json({ flow: toApiFlow(flow) }, { status: 201 });
    }

    // -------- Plain (empty) create path --------
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const triggerType = body.trigger_type ?? "keyword";

    const [flow] = await db
      .insert(flows)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name: body.name.trim(),
        description: body.description ?? null,
        status: "draft",
        triggerType,
        triggerConfig: body.trigger_config ?? {},
      })
      .returning();

    if (!flow) {
      return NextResponse.json({ error: "insert failed" }, { status: 500 });
    }
    return NextResponse.json({ flow: toApiFlow(flow) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}