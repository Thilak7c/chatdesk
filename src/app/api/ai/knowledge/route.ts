import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { aiKnowledgeDocuments } from '@/db/schema'
import { toSnakeRows } from '@/db/serialize'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member).
 */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const rows = await db
      .select({
        id: aiKnowledgeDocuments.id,
        title: aiKnowledgeDocuments.title,
        updatedAt: aiKnowledgeDocuments.updatedAt,
      })
      .from(aiKnowledgeDocuments)
      .where(eq(aiKnowledgeDocuments.accountId, accountId))
      .orderBy(desc(aiKnowledgeDocuments.updatedAt))
    return NextResponse.json({ documents: toSnakeRows(rows) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Create a document, then chunk + (optionally) embed it. If indexing
 * fails the document is still saved so the admin can retry via reindex.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json(
        { error: 'title and content are required' },
        { status: 400 },
      )
    }

    const [doc] = await db
      .insert(aiKnowledgeDocuments)
      .values({ accountId, createdBy: userId, title, content })
      .returning({ id: aiKnowledgeDocuments.id })

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(db, accountId)
    try {
      await ingestDocument(
        db,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content,
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true, id: doc.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
