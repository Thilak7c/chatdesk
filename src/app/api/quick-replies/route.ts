import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { quickReplies } from '@/db/schema'
import { toSnake, toSnakeRows } from '@/db/serialize'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// Quick replies — reusable snippets (plain text or a saved interactive
// message) shared across the account. GET lists (any member); POST
// creates (agent+).

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const rows = await db
      .select()
      .from(quickReplies)
      .where(eq(quickReplies.accountId, accountId))
      .orderBy(desc(quickReplies.createdAt))
    return NextResponse.json({ quick_replies: toSnakeRows(rows) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const kind = body.kind === 'interactive' ? 'interactive' : 'text'
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 })
    }

    let contentText: string | null = null
    let interactivePayload: unknown = null

    if (kind === 'interactive') {
      const result = validateInteractivePayload(body.interactive_payload)
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      interactivePayload = body.interactive_payload
    } else {
      const text = typeof body.content_text === 'string' ? body.content_text : ''
      if (!text.trim()) {
        return NextResponse.json(
          { error: 'content_text is required for text quick replies' },
          { status: 400 },
        )
      }
      contentText = text
    }

    const [data] = await db
      .insert(quickReplies)
      .values({
        accountId: ctx.accountId,
        userId: ctx.userId,
        title,
        kind,
        contentText,
        interactivePayload,
      })
      .returning()

    return NextResponse.json({ quick_reply: toSnake(data) }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
