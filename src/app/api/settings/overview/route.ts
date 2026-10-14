// src/app/api/settings/overview/route.ts

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customFields,
  messageTemplates,
  tags,
  whatsappConfig,
} from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const [templateRows, tagRows, fieldRows, whatsappRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          pending: sql<number>`(count(*) filter (where ${messageTemplates.status} = 'PENDING'))::int`,
        })
        .from(messageTemplates)
        .where(eq(messageTemplates.accountId, ctx.accountId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(tags)
        .where(eq(tags.accountId, ctx.accountId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(customFields)
        .where(eq(customFields.accountId, ctx.accountId)),
      db
        .select({ id: whatsappConfig.id })
        .from(whatsappConfig)
        .where(eq(whatsappConfig.accountId, ctx.accountId))
        .limit(1),
    ]);

    return NextResponse.json({
      templates: templateRows[0]?.total ?? 0,
      templatesPending: templateRows[0]?.pending ?? 0,
      tags: tagRows[0]?.count ?? 0,
      customFields: fieldRows[0]?.count ?? 0,
      whatsappConfigured: whatsappRows.length > 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}