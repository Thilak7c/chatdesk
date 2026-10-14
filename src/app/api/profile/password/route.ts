// src/app/api/profile/password/route.ts

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { changePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/users";

const MIN_PASSWORD = MIN_PASSWORD_LENGTH;
const MAX_PASSWORD = MAX_PASSWORD_LENGTH;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole("viewer");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const current = typeof body.current_password === "string" ? body.current_password : "";
    const next = typeof body.new_password === "string" ? body.new_password : "";

    if (!current || !next) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }
    if (next.length < MIN_PASSWORD) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD} characters` },
        { status: 400 }
      );
    }
    if (next.length > MAX_PASSWORD) {
      return NextResponse.json({ error: "Password is too long" }, { status: 400 });
    }

    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    if (!user || !user.passwordHash) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const valid = await bcrypt.compare(current, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "incorrect_password" }, { status: 400 });
    }

    // Keeps this browser signed in; every other device is signed out.
    await changePassword(ctx.userId, next, ctx.sessionId);

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}