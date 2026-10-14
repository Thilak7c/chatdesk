import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { profiles, accounts, users } from "@/db/schema";
import { getSession } from "@/lib/auth/session";

/**
 * Who am I? — the signed-in user, their profile and account. This is
 * what the client-side AuthProvider bootstraps from. 401 when there
 * is no valid session.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [row] = await db
    .select({ profile: profiles, account: accounts })
    .from(profiles)
    .leftJoin(accounts, eq(accounts.id, profiles.accountId))
    .where(eq(profiles.userId, session.user.id))
    .limit(1);

  const [userRow] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const user = {
    id: session.user.id,
    email: session.user.email,
    created_at: userRow?.createdAt.toISOString() ?? null,
  };
  if (!row) {
    return NextResponse.json({ user, profile: null, account: null });
  }

  const { profile, account } = row;
  return NextResponse.json({
    user,
    profile: {
      id: profile.id,
      full_name: profile.fullName,
      email: profile.email,
      avatar_url: profile.avatarUrl,
      role: profile.role,
      beta_features: profile.betaFeatures,
      account_id: profile.accountId,
      account_role: profile.accountRole,
    },
    account: account
      ? { id: account.id, name: account.name, default_currency: account.defaultCurrency }
      : null,
  });
}
