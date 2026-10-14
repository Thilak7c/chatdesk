import { eq } from 'drizzle-orm'

import type { DbOrTx } from '@/db'
import { aiConfigs } from '@/db/schema'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig } from './types'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 */
export async function loadAiConfig(
  db: DbOrTx,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const [row] = await db
    .select()
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
    .limit(1)

  if (!row) return null

  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.isActive) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on an empty string.
  if (!row.apiKey) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddingsApiKey) {
    try {
      embeddingsApiKey = decrypt(row.embeddingsApiKey)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider as AiConfig['provider'],
    model: row.model,
    apiKey: decrypt(row.apiKey),
    systemPrompt: row.systemPrompt,
    isActive: row.isActive,
    autoReplyEnabled: row.autoReplyEnabled,
    autoReplyMaxPerConversation: row.autoReplyMaxPerConversation,
    handoffAgentId: row.handoffAgentId,
    embeddingsApiKey,
    confidenceThreshold: row.confidenceThreshold,
    hardEscalateKeywords: Array.isArray(row.hardEscalateKeywords)
      ? (row.hardEscalateKeywords as string[])
      : [],
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: DbOrTx,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const [row] = await db
    .select({ embeddingsApiKey: aiConfigs.embeddingsApiKey })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
    .limit(1)
  if (!row?.embeddingsApiKey) return { key: null, corrupt: false }
  try {
    return { key: decrypt(row.embeddingsApiKey), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}
