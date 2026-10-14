import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { automations, automationSteps } from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id } = await params

    const [original] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, accountId)))
      .limit(1)
    if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const copy = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(automations)
        .values({
          accountId,
          userId,
          name: `${original.name} (Copy)`,
          description: original.description,
          triggerType: original.triggerType,
          triggerConfig: original.triggerConfig,
          isActive: false,
        })
        .returning()

      const steps = await tx
        .select()
        .from(automationSteps)
        .where(eq(automationSteps.automationId, id))
        .orderBy(asc(automationSteps.position))

      if (steps.length > 0) {
        // Re-map parent_step_id: assign every new id first so each row
        // can point at its copied parent.
        const idMap = new Map(steps.map((s) => [s.id, randomUUID()]))
        await tx.insert(automationSteps).values(
          steps.map((s) => ({
            id: idMap.get(s.id)!,
            automationId: created.id,
            parentStepId: s.parentStepId ? (idMap.get(s.parentStepId) ?? null) : null,
            branch: s.branch,
            stepType: s.stepType,
            stepConfig: s.stepConfig,
            position: s.position,
          })),
        )
      }
      return created
    })

    return NextResponse.json({ automation: toSnake(copy) }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
