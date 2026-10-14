// src/app/api/custom-fields/[id]/route.ts

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { customFields } from "@/db/schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const body = await req.json();
    const fieldName = typeof body.field_name === "string" ? body.field_name.trim() : "";

    if (!fieldName) {
      return NextResponse.json({ error: "field_name is required" }, { status: 400 });
    }

    const existing = await db
      .select({ id: customFields.id, fieldName: customFields.fieldName })
      .from(customFields)
      .where(eq(customFields.accountId, ctx.accountId));

    if (existing.some((f) => f.id !== id && f.fieldName.toLowerCase() === fieldName.toLowerCase())) {
      return NextResponse.json(
        { error: `A field named "${fieldName}" already exists` },
        { status: 409 },
      );
    }

    const rows = await db
      .update(customFields)
      .set({ fieldName })
      .where(and(eq(customFields.id, id), eq(customFields.accountId, ctx.accountId)))
      .returning();

    if (!rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ id: rows[0].id, field_name: rows[0].fieldName });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;

    const rows = await db
      .delete(customFields)
      .where(and(eq(customFields.id, id), eq(customFields.accountId, ctx.accountId)))
      .returning({ id: customFields.id });

    if (!rows[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}