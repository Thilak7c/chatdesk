// src/app/api/tags/route.ts

import { NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import { tags } from "@/db/schema";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await db
      .select()
      .from(tags)
      .where(eq(tags.accountId, ctx.accountId))
      .orderBy(asc(tags.name));

    return NextResponse.json({
      tags: rows.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    });
  } catch (err) {
    console.error("GET /api/tags failed:", err);
    return NextResponse.json({ error: "Failed to load tags" }, { status: 500 });
  }
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** POST /api/tags — create a tag (admin+; tag definitions are settings). */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; color?: unknown }
      | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 50) {
      return NextResponse.json({ error: "Tag name must be 1-50 characters" }, { status: 400 });
    }
    const color =
      typeof body?.color === "string" && HEX_COLOR.test(body.color) ? body.color : "#3b82f6";

    const [tag] = await db
      .insert(tags)
      .values({ accountId: ctx.accountId, userId: ctx.userId, name, color })
      .returning();
    return NextResponse.json(
      { tag: { id: tag.id, name: tag.name, color: tag.color } },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
