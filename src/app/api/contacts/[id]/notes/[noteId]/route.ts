// src/app/api/contacts/notes/[noteId]/route.ts

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { contacts, contactNotes } from "@/db/schema";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ noteId: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { noteId } = await params;

    // contact_notes has no account_id column — verify ownership through
    // the parent contact instead of trusting the note row alone.
    const row = await db
      .select({ noteId: contactNotes.id })
      .from(contactNotes)
      .innerJoin(contacts, eq(contactNotes.contactId, contacts.id))
      .where(and(eq(contactNotes.id, noteId), eq(contacts.accountId, ctx.accountId)))
      .limit(1);

    if (!row[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db.delete(contactNotes).where(eq(contactNotes.id, noteId));

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}