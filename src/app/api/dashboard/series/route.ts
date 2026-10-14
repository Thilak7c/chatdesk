import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { loadConversationsSeries } from "@/lib/dashboard/queries";

export async function GET(req: Request) {
  try {
    const ctx = await requireRole("viewer");
    const { searchParams } = new URL(req.url);
    const days = Number(searchParams.get("days") ?? "30");
    const series = await loadConversationsSeries(ctx.accountId, days);
    return NextResponse.json({ series });
  } catch (err) {
    return toErrorResponse(err);
  }
}