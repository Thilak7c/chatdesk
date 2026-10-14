import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { quickReplies } from '@/db/schema'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// Update / delete a single quick reply. Quick replies are account-
// shared, so every mutation is scoped by `account_id` (agent+).

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Partial<typeof quickReplies.$inferInsert> = {}
  if (typeof body.title === 'string') {
    const title = body.title.trim()
    if (!title) return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    update.title = title
  }

  // When `kind` is supplied (e.g. the editor flips Text ↔ Interactive), it
  // drives which content column is authoritative and the other is cleared —
  // otherwise a switched row keeps a stale payload the picker mis-routes on.
  if ('kind' in body) {
    if (body.kind !== 'text' && body.kind !== 'interactive') {
      return NextResponse.json({ error: 'kind must be "text" or "interactive"' }, { status: 400 })
    }
    update.kind = body.kind
    if (body.kind === 'interactive') {
      const result = validateInteractivePayload(body.interactive_payload)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      update.interactivePayload = body.interactive_payload
      update.contentText = null
    } else {
      const text = typeof body.content_text === 'string' ? body.content_text : ''
      if (!text.trim()) {
        return NextResponse.json(
          { error: 'content_text is required for text quick replies' },
          { status: 400 },
        )
      }
      update.contentText = text
      update.interactivePayload = null
    }
  } else {
    // No kind change — allow partial edits of whichever field the row uses.
    if ('content_text' in body) update.contentText = body.content_text ?? null
    if ('interactive_payload' in body) {
      if (body.interactive_payload != null) {
        const result = validateInteractivePayload(body.interactive_payload)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 })
        }
      }
      update.interactivePayload = body.interactive_payload ?? null
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  await db
    .update(quickReplies)
    .set(update)
    .where(and(eq(quickReplies.id, id), eq(quickReplies.accountId, ctx.accountId)))
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  await db
    .delete(quickReplies)
    .where(and(eq(quickReplies.id, id), eq(quickReplies.accountId, ctx.accountId)))
  return NextResponse.json({ ok: true })
}
