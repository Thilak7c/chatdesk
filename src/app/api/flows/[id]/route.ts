import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { flowNodes, flows } from '@/db/schema'
import { toSnake, toSnakeRows } from '@/db/serialize'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET    /api/flows/[id] — fetch one flow with its nodes.
 * PUT    /api/flows/[id] — replace name/trigger/entry/fallback and,
 *                          when `nodes` is sent, the full node graph
 *                          (in one transaction).
 * DELETE /api/flows/[id] — hard delete; nodes, runs and events cascade.
 *
 * Every query is scoped to the caller's account; a flow in another
 * account is a 404.
 */

async function findFlow(accountId: string, id: string) {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
    .limit(1)
  return flow ?? null
}

async function loadNodes(flowId: string) {
  return db
    .select()
    .from(flowNodes)
    .where(eq(flowNodes.flowId, flowId))
    .orderBy(asc(flowNodes.createdAt))
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await getCurrentAccount()
    const { id } = await context.params
    const flow = await findFlow(accountId, id)
    if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ flow: toSnake(flow), nodes: toSnakeRows(await loadNodes(id)) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await context.params
    if (!(await findFlow(accountId, id))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    }

    const flowPatch: Partial<typeof flows.$inferInsert> = {}
    if (body.name !== undefined) flowPatch.name = body.name.trim()
    if (body.description !== undefined) flowPatch.description = body.description
    if (body.trigger_type !== undefined) flowPatch.triggerType = body.trigger_type
    if (body.trigger_config !== undefined) flowPatch.triggerConfig = body.trigger_config
    if (body.entry_node_id !== undefined) flowPatch.entryNodeId = body.entry_node_id
    if (body.fallback_policy !== undefined) flowPatch.fallbackPolicy = body.fallback_policy

    await db.transaction(async (tx) => {
      // Always bump updated_at, even for a nodes-only save.
      await tx.update(flows).set({ ...flowPatch, updatedAt: new Date() }).where(eq(flows.id, id))

      // `nodes` absent = header-only save (e.g. editing the trigger
      // without touching the graph).
      if (body.nodes !== undefined) {
        await tx.delete(flowNodes).where(eq(flowNodes.flowId, id))
        if (body.nodes.length > 0) {
          await tx.insert(flowNodes).values(
            body.nodes.map((n) => ({
              flowId: id,
              nodeKey: n.node_key,
              nodeType: n.node_type,
              config: n.config,
              positionX: n.position_x ?? 0,
              positionY: n.position_y ?? 0,
            })),
          )
        }
      }
    })

    // Return the new state — the editor reconciles its form from it.
    const flow = await findFlow(accountId, id)
    return NextResponse.json({ flow: flow && toSnake(flow), nodes: toSnakeRows(await loadNodes(id)) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await context.params
    // CASCADE removes nodes / runs / events. Active runs end abruptly —
    // deleting a flow is deliberate, and the one-active-run index frees
    // the contact for new triggers immediately.
    const deleted = await db
      .delete(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .returning({ id: flows.id })
    if (deleted.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
