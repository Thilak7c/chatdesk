import { NextResponse } from 'next/server'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/db'
import { contacts, flowRunEvents, flowRuns, flows } from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/flows/[id]/runs
 *
 * Newest-first list of flow runs for a single flow, with each run's
 * event timeline. Used by the run-history viewer page
 * (`/flows/[id]/runs`) to give end-to-end visibility into what the bot
 * did with each customer.
 *
 * Limited to the 50 most recent runs — the surface is for debugging,
 * not heavy querying.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await getCurrentAccount()
    const { id } = await context.params

    const [flow] = await db
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1)
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const runRows = await db
      .select({
        run: {
          id: flowRuns.id,
          status: flowRuns.status,
          currentNodeKey: flowRuns.currentNodeKey,
          startedAt: flowRuns.startedAt,
          lastAdvancedAt: flowRuns.lastAdvancedAt,
          endedAt: flowRuns.endedAt,
          endReason: flowRuns.endReason,
          vars: flowRuns.vars,
          repromptCount: flowRuns.repromptCount,
        },
        contact: { id: contacts.id, name: contacts.name, phone: contacts.phone },
      })
      .from(flowRuns)
      .leftJoin(contacts, eq(contacts.id, flowRuns.contactId))
      .where(and(eq(flowRuns.flowId, id), eq(flowRuns.accountId, accountId)))
      .orderBy(desc(flowRuns.startedAt))
      .limit(50)

    const runs = runRows.map((r) => ({
      ...toSnake(r.run),
      contact: r.contact?.id ? r.contact : null,
    }))

    const runIds = runs.map((r) => r.id)
    const events =
      runIds.length === 0
        ? []
        : (
            await db
              .select({
                flowRunId: flowRunEvents.flowRunId,
                eventType: flowRunEvents.eventType,
                nodeKey: flowRunEvents.nodeKey,
                payload: flowRunEvents.payload,
                createdAt: flowRunEvents.createdAt,
              })
              .from(flowRunEvents)
              .where(inArray(flowRunEvents.flowRunId, runIds))
              .orderBy(asc(flowRunEvents.createdAt))
          ).map(toSnake)

    return NextResponse.json({ flow, runs, events })
  } catch (err) {
    return toErrorResponse(err)
  }
}
