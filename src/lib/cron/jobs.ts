// ============================================================
// Background jobs.
//
// Run in-process on a timer by src/instrumentation.ts, and also
// exposed as secret-protected HTTP endpoints (/api/automations/cron,
// /api/flows/cron) for deployments that prefer an external scheduler.
// Each job is safe to run concurrently with itself: rows are claimed
// with a conditional UPDATE before being worked on.
// ============================================================

import { and, asc, eq, lte } from 'drizzle-orm'

import { db } from '@/db'
import { automationPendingExecutions, flowRunEvents, flowRuns, flows } from '@/db/schema'
import { resumePendingExecution, type AutomationContext } from '@/lib/automations/engine'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { purgeExpiredSessions } from '@/lib/auth/session'

/** Resume automation runs whose `wait` step has elapsed. */
export async function processDueAutomationExecutions(batchSize = 50): Promise<number> {
  const due = await db
    .select()
    .from(automationPendingExecutions)
    .where(
      and(
        eq(automationPendingExecutions.status, 'pending'),
        lte(automationPendingExecutions.runAt, new Date()),
      ),
    )
    .orderBy(asc(automationPendingExecutions.runAt))
    .limit(batchSize)

  let processed = 0
  for (const row of due) {
    // Claim: only one worker flips pending → running.
    const [claim] = await db
      .update(automationPendingExecutions)
      .set({ status: 'running' })
      .where(
        and(
          eq(automationPendingExecutions.id, row.id),
          eq(automationPendingExecutions.status, 'pending'),
        ),
      )
      .returning({ id: automationPendingExecutions.id })
    if (!claim) continue

    await resumePendingExecution({
      id: row.id,
      automation_id: row.automationId,
      account_id: row.accountId,
      user_id: row.userId,
      contact_id: row.contactId,
      log_id: row.logId,
      parent_step_id: row.parentStepId,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.nextStepPosition,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }
  return processed
}

/**
 * Time out abandoned flow runs. Without this, a customer who walks
 * away mid-flow keeps an active run forever, and the one-active-run-
 * per-contact index blocks every new flow for them.
 */
export async function sweepStaleFlowRuns(): Promise<number> {
  const now = new Date()
  const runs = await db
    .select({
      id: flowRuns.id,
      lastAdvancedAt: flowRuns.lastAdvancedAt,
      fallbackPolicy: flows.fallbackPolicy,
    })
    .from(flowRuns)
    .innerJoin(flows, eq(flows.id, flowRuns.flowId))
    .where(eq(flowRuns.status, 'active'))

  let swept = 0
  for (const r of runs) {
    const policy = resolveFallbackPolicy(r.fallbackPolicy ?? null)
    const ageHours = (now.getTime() - r.lastAdvancedAt.getTime()) / 3_600_000
    if (ageHours < policy.on_timeout_hours) continue

    // Guarded on status='active' so a late inbound that just advanced
    // the run isn't overwritten.
    const updated = await db
      .update(flowRuns)
      .set({ status: 'timed_out', endedAt: now, endReason: 'stale_sweep' })
      .where(and(eq(flowRuns.id, r.id), eq(flowRuns.status, 'active')))
      .returning({ id: flowRuns.id })
    if (updated.length === 0) continue

    await db.insert(flowRunEvents).values({
      flowRunId: r.id,
      eventType: 'timeout',
      payload: {
        age_hours: Math.round(ageHours * 10) / 10,
        policy_hours: policy.on_timeout_hours,
      },
    })
    swept++
  }
  return swept
}

/** Drop expired login sessions. */
export async function cleanupExpiredSessions(): Promise<number> {
  return purgeExpiredSessions()
}
