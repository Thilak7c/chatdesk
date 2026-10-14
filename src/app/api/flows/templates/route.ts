// src/app/api/flows/templates/route.ts

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { listFlowTemplates } from "@/lib/flows/templates";

export async function GET() {
  try {
    await requireRole("viewer");

    const templates = listFlowTemplates().map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      trigger_type: t.trigger_type,
      node_count: t.nodes.length,
    }));
    return NextResponse.json({ templates });
  } catch (err) {
    return toErrorResponse(err);
  }
}