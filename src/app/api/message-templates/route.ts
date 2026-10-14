// src/app/api/message-templates/route.ts

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messageTemplates } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

function toApiTemplate(t: typeof messageTemplates.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    language: t.language,
    header_type: t.headerType,
    header_content: t.headerContent,
    header_media_url: t.headerMediaUrl,
    body_text: t.bodyText,
    footer_text: t.footerText,
    buttons: t.buttons,
    status: t.status,
    sample_values: t.sampleValues,
    meta_template_id: t.metaTemplateId,
    rejection_reason: t.rejectionReason,
    submission_error: t.submissionError,
    quality_score: t.qualityScore,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRole("viewer");
    const status = request.nextUrl.searchParams.get("status");

    const conditions = [eq(messageTemplates.accountId, ctx.accountId)];
    if (status) conditions.push(eq(messageTemplates.status, status));

    const rows = await db
      .select()
      .from(messageTemplates)
      .where(and(...conditions))
      .orderBy(desc(messageTemplates.createdAt));

    return NextResponse.json({ templates: rows.map(toApiTemplate) });
  } catch (err) {
    return toErrorResponse(err);
  }
}