import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { flowNodes, flows } from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateFlowForActivation } from '@/lib/flows/validate'

/**
 * POST /api/flows/[id]/activate
 *
 * Body: { status: 'draft' | 'active' | 'archived' }
 *
 * Activating runs the full validator and refuses on any 'error'
 * severity issue. Drafts and archives are unconditional — users
 * need to be able to save broken-work-in-progress and pause flows
 * without first fixing them.
 *
 * Returns the updated flow on success; on validation failure returns
 * the full issue list so the builder can highlight each problem.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await context.params

    const body = (await request.json().catch(() => null)) as
      | { status?: 'draft' | 'active' | 'archived' }
      | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) {
      return NextResponse.json(
        { error: "status must be one of 'draft' | 'active' | 'archived'" },
        { status: 400 },
      )
    }

    const [flow] = await db
      .select({
        name: flows.name,
        triggerType: flows.triggerType,
        triggerConfig: flows.triggerConfig,
        entryNodeId: flows.entryNodeId,
      })
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1)
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (status === 'active') {
      const nodes = await db
        .select({ node_key: flowNodes.nodeKey, node_type: flowNodes.nodeType, config: flowNodes.config })
        .from(flowNodes)
        .where(eq(flowNodes.flowId, id))
      const issues = validateFlowForActivation(
        {
          name: flow.name,
          trigger_type: flow.triggerType as 'keyword' | 'first_inbound_message' | 'manual',
          trigger_config: flow.triggerConfig as Record<string, unknown>,
          entry_node_id: flow.entryNodeId,
        },
        nodes as Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>,
      )
      if (issues.some((i) => i.severity === 'error')) {
        return NextResponse.json(
          { error: 'Cannot activate flow — fix the issues below first.', issues },
          { status: 422 },
        )
      }
    }

    const [updated] = await db
      .update(flows)
      .set({ status })
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .returning()
    return NextResponse.json({ flow: updated && toSnake(updated) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
