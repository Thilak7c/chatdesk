import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { whatsappConfig } from "@/db/schema";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const config = await db.query.whatsappConfig.findFirst({
      where: eq(whatsappConfig.accountId, ctx.accountId),
      columns: { status: true },
    });

    return NextResponse.json({ connected: config?.status === "connected" });
  } catch (err) {
    return toErrorResponse(err);
  }
}