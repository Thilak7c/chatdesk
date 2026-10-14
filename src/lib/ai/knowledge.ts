import { and, asc, cosineDistance, desc, eq, isNotNull, sql } from 'drizzle-orm'

import type { DbOrTx } from '@/db'
import { aiKnowledgeChunks } from '@/db/schema'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

export interface KnowledgeResult {
  chunks: string[]
  /**
   * Cosine distance of the single best semantic match, or null when no
   * embeddings key is configured (lexical-only path has no comparable
   * score) or nothing matched. Lower is more confident. This is the
   * deterministic signal `auto-reply.ts` checks against
   * `confidence_threshold` before ever calling the LLM.
   */
  bestDistance: number | null
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs on whatever db handle or
 * transaction the caller passes.
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: DbOrTx,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  await db.delete(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.documentId, documentId))

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  await db.insert(aiKnowledgeChunks).values(
    chunks.map((content, i) => ({
      documentId,
      accountId,
      chunkIndex: i,
      content,
      embedding: embeddings ? embeddings[i] : null,
    })),
  )

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, query error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: DbOrTx,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<KnowledgeResult> {
  const query = queryText.trim()
  const empty: KnowledgeResult = { chunks: [], bestDistance: null }
  if (!query || k <= 0) return empty

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two
  // searches just to get []. One cheap indexed existence probe instead
  // of a paid embeddings call on the hot path.
  try {
    const probe = await db
      .select({ id: aiKnowledgeChunks.id })
      .from(aiKnowledgeChunks)
      .where(eq(aiKnowledgeChunks.accountId, accountId))
      .limit(1)
    if (probe.length === 0) return empty
  } catch {
    return empty
  }

  const picked = new Map<string, string>() // id → content, preserves order
  let bestDistance: number | null = null

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        // Cosine distance (pgvector `<=>`): 0 = identical, 2 = opposite.
        const distance = cosineDistance(aiKnowledgeChunks.embedding, queryEmbedding)
        const rows = await db
          .select({
            id: aiKnowledgeChunks.id,
            content: aiKnowledgeChunks.content,
            distance: sql<number>`${distance}`.mapWith(Number),
          })
          .from(aiKnowledgeChunks)
          .where(
            and(
              eq(aiKnowledgeChunks.accountId, accountId),
              isNotNull(aiKnowledgeChunks.embedding),
            ),
          )
          .orderBy(asc(distance))
          .limit(k)
        // Rows come back nearest-first, so the first row is the best
        // match — capture its distance before the Map loses ordering.
        if (rows.length > 0) bestDistance = rows[0].distance
        for (const row of rows) picked.set(row.id, row.content)
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  // Note: full-text search has no distance-like score comparable to
  // cosine distance, so bestDistance stays null when this is the only
  // path — the confidence-threshold check in auto-reply.ts is skipped
  // in that case and only the LLM's own handoff judgment applies.
  if (picked.size < k) {
    try {
      const tsQuery = sql`plainto_tsquery('simple', ${query})`
      const rows = await db
        .select({ id: aiKnowledgeChunks.id, content: aiKnowledgeChunks.content })
        .from(aiKnowledgeChunks)
        .where(
          and(
            eq(aiKnowledgeChunks.accountId, accountId),
            sql`${aiKnowledgeChunks.fts} @@ ${tsQuery}`,
          ),
        )
        .orderBy(desc(sql`ts_rank(${aiKnowledgeChunks.fts}, ${tsQuery})`))
        .limit(k)
      for (const row of rows) {
        if (picked.size >= k) break
        if (!picked.has(row.id)) picked.set(row.id, row.content)
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return { chunks: Array.from(picked.values()).slice(0, k), bestDistance }
}
