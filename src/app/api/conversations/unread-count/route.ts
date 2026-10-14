import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { conversations } from "@/db/schema";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.accountId, ctx.accountId), gt(conversations.unreadCount, 0)));

    return NextResponse.json({ total: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}