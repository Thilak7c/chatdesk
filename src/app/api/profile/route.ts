// src/app/api/profile/route.ts

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireRole("viewer");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const patch: Partial<typeof profiles.$inferInsert> = { updatedAt: new Date() };

    if ("full_name" in body) {
      const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
      if (!name) {
        return NextResponse.json({ error: "Name is required" }, { status: 400 });
      }
      if (name.length > 120) {
        return NextResponse.json({ error: "Name is too long" }, { status: 400 });
      }
      patch.fullName = name;
    }

    if ("avatar_url" in body && body.avatar_url === null) {
      patch.avatarUrl = null;
    }

    const [row] = await db
      .update(profiles)
      .set(patch)
      .where(eq(profiles.userId, ctx.userId))
      .returning();

    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      profile: {
        id: row.id,
        user_id: row.userId,
        account_id: row.accountId,
        account_role: row.accountRole,
        full_name: row.fullName,
        email: row.email,
        avatar_url: row.avatarUrl,
        role: row.role,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}