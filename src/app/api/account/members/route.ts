// src/app/api/account/members/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { and, eq, isNotNull, asc } from "drizzle-orm";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const rows = await db
      .select({
        userId: profiles.userId,
        fullName: profiles.fullName,
        email: profiles.email,
        avatarUrl: profiles.avatarUrl,
        accountRole: profiles.accountRole,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .where(and(eq(profiles.accountId, ctx.accountId), isNotNull(profiles.accountRole)))
      .orderBy(asc(profiles.createdAt));

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = rows.flatMap((row) => {
      if (!isAccountRole(row.accountRole)) return [];
      return [
        {
          user_id: row.userId,
          full_name: row.fullName ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatarUrl,
          role: row.accountRole,
          joined_at: row.createdAt?.toISOString() ?? "",
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}