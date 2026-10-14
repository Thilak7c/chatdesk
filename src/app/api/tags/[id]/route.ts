// src/app/api/tags/[id]/route.ts

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { tags } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

/** DELETE /api/tags/[id] — delete a tag (admin+). Detaches it from every contact. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const deleted = await db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)))
      .returning({ id: tags.id });
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
