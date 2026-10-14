// src/app/api/contacts/[id]/custom-values/route.ts

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { contacts, contactCustomValues } from "@/db/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;

    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)),
      columns: { id: true },
    });
    if (!contact) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(contactCustomValues)
      .where(eq(contactCustomValues.contactId, id));

    const values: Record<string, string> = {};
    for (const r of rows) {
      values[r.customFieldId] = r.value ?? "";
    }

    return NextResponse.json({ values });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT — full replace, same semantics as the old "delete existing then
 * re-insert" flow in contact-detail-view.tsx.
 * Body: { values: Record<customFieldId, value> }
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const body = await req.json();
    const values = (body.values ?? {}) as Record<string, string>;

    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)),
      columns: { id: true },
    });
    if (!contact) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db.delete(contactCustomValues).where(eq(contactCustomValues.contactId, id));

    const rows = Object.entries(values)
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([fieldId, v]) => ({
        contactId: id,
        customFieldId: fieldId,
        value: v.trim(),
      }));

    if (rows.length > 0) {
      await db.insert(contactCustomValues).values(rows);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}