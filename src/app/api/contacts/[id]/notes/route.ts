// src/app/api/contacts/[id]/notes/route.ts

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { contacts, contactNotes } from "@/db/schema";

function toNoteJson(n: typeof contactNotes.$inferSelect) {
  return {
    id: n.id,
    contact_id: n.contactId,
    user_id: n.userId,
    note_text: n.noteText,
    created_at: n.createdAt,
  };
}

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
      .from(contactNotes)
      .where(eq(contactNotes.contactId, id))
      .orderBy(desc(contactNotes.createdAt));

    return NextResponse.json({ notes: rows.map(toNoteJson) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const body = await req.json();
    const noteText = typeof body.note_text === "string" ? body.note_text.trim() : "";

    if (!noteText) {
      return NextResponse.json({ error: "note_text is required" }, { status: 400 });
    }

    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)),
      columns: { id: true },
    });
    if (!contact) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .insert(contactNotes)
      .values({ contactId: id, userId: ctx.userId, accountId: ctx.accountId, noteText })
      .returning();

    return NextResponse.json(toNoteJson(rows[0]));
  } catch (err) {
    return toErrorResponse(err);
  }
}