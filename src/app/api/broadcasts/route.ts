// src/app/api/broadcasts/route.ts

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { broadcasts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

function toApiBroadcast(b: typeof broadcasts.$inferSelect) {
  return {
    id: b.id,
    name: b.name,
    template_name: b.templateName,
    template_language: b.templateLanguage,
    template_variables: b.templateVariables,
    audience_filter: b.audienceFilter,
    scheduled_at: b.scheduledAt,
    status: b.status,
    total_recipients: b.totalRecipients,
    sent_count: b.sentCount,
    delivered_count: b.deliveredCount,
    read_count: b.readCount,
    replied_count: b.repliedCount,
    failed_count: b.failedCount,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
  };
}

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.accountId, ctx.accountId))
      .orderBy(desc(broadcasts.createdAt));

    return NextResponse.json({ broadcasts: rows.map(toApiBroadcast) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireRole("agent");
    const body = await request.json();
    const {
      name,
      template_name,
      template_language,
      template_variables,
      audience_filter,
      status,
      total_recipients,
    } = body;

    if (!name || !template_name) {
      return NextResponse.json({ error: "name and template_name are required" }, { status: 400 });
    }

    const [created] = await db
      .insert(broadcasts)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name,
        templateName: template_name,
        templateLanguage: template_language ?? "en_US",
        templateVariables: template_variables ?? {},
        audienceFilter: audience_filter ?? {},
        status: status ?? "draft",
        totalRecipients: total_recipients ?? 0,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        repliedCount: 0,
        failedCount: 0,
      })
      .returning();

    return NextResponse.json({ broadcast: toApiBroadcast(created) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}