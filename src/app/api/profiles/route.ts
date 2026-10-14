// src/app/api/profiles/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { and, eq, isNotNull, asc } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const rows = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.accountId, ctx.accountId), isNotNull(profiles.accountRole)))
      .orderBy(asc(profiles.createdAt));

    const result = rows.map((p) => ({
      id: p.id,
      user_id: p.userId,
      account_id: p.accountId,
      account_role: p.accountRole,
      full_name: p.fullName,
      email: p.email,
      avatar_url: p.avatarUrl,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    }));

    return NextResponse.json({ profiles: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}