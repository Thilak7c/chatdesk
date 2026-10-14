import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { aiKnowledgeDocuments } from '@/db/schema'
import { toSnake } from '@/db/serialize'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/knowledge/[id] — full document (any member).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { accountId } = await getCurrentAccount()
    const { id } = await params
    const [data] = await db
      .select({
        id: aiKnowledgeDocuments.id,
        title: aiKnowledgeDocuments.title,
        content: aiKnowledgeDocuments.content,
        updatedAt: aiKnowledgeDocuments.updatedAt,
      })
      .from(aiKnowledgeDocuments)
      .where(and(eq(aiKnowledgeDocuments.accountId, accountId), eq(aiKnowledgeDocuments.id, id)))
      .limit(1)
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(toSnake(data))
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/knowledge/[id]  (admin+) — update title/content and
 * re-index when the content changed.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })
    }

    const update: Record<string, string> = {}
    if (title !== undefined) update.title = title
    if (content !== undefined) update.content = content

    const [updated] = await db
      .update(aiKnowledgeDocuments)
      .set(update)
      .where(and(eq(aiKnowledgeDocuments.accountId, accountId), eq(aiKnowledgeDocuments.id, id)))
      .returning({ id: aiKnowledgeDocuments.id })
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(db, accountId)
      try {
        await ingestDocument(db, accountId, { embeddingsApiKey }, id, content)
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'indexing failed'
        console.error('[ai/knowledge/[id] PATCH] ingest error:', err)
        return NextResponse.json(
          {
            success: true,
            warning: `Updated, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
          },
          { status: 200 },
        )
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Updated with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge/[id]  (admin+) — chunks cascade.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('admin')
    const { id } = await params
    await db
      .delete(aiKnowledgeDocuments)
      .where(and(eq(aiKnowledgeDocuments.accountId, accountId), eq(aiKnowledgeDocuments.id, id)))
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
