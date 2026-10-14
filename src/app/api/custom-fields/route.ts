// src/app/api/custom-fields/route.ts

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { customFields } from "@/db/schema";

function toJson(f: typeof customFields.$inferSelect) {
  return {
    id: f.id,
    account_id: f.accountId,
    field_name: f.fieldName,
    field_type: f.fieldType,
    field_options: f.fieldOptions,
    created_at: f.createdAt,
  };
}

export async function GET() {
  try {
    const ctx = await requireRole("viewer");
    const rows = await db
      .select()
      .from(customFields)
      .where(eq(customFields.accountId, ctx.accountId))
      .orderBy(asc(customFields.fieldName));
    return NextResponse.json({ customFields: rows.map(toJson) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await req.json();
    const fieldName = typeof body.field_name === "string" ? body.field_name.trim() : "";

    if (!fieldName) {
      return NextResponse.json({ error: "field_name is required" }, { status: 400 });
    }

    const existing = await db
      .select({ fieldName: customFields.fieldName })
      .from(customFields)
      .where(eq(customFields.accountId, ctx.accountId));

    if (existing.some((f) => f.fieldName.toLowerCase() === fieldName.toLowerCase())) {
      return NextResponse.json(
        { error: `A field named "${fieldName}" already exists` },
        { status: 409 },
      );
    }

    const rows = await db
      .insert(customFields)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        fieldName,
        fieldType: "text",
      })
      .returning();

    return NextResponse.json(toJson(rows[0]));
  } catch (err) {
    return toErrorResponse(err);
  }
}