import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from "@/lib/dashboard/queries";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const [metrics, series30, pipeline, responseTime, activity] = await Promise.all([
      loadMetrics(ctx.accountId),
      loadConversationsSeries(ctx.accountId, 30),
      loadPipelineDonut(ctx.accountId),
      loadResponseTime(ctx.accountId),
      loadActivity(ctx.accountId, 50),
    ]);

    return NextResponse.json({ metrics, series30, pipeline, responseTime, activity });
  } catch (err) {
    return toErrorResponse(err);
  }
}