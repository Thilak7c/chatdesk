import type { DbOrTx } from '@/db'
import { aiUsageLog } from '@/db/schema'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 */
export async function logAiUsage(
  db: DbOrTx,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    await db.insert(aiUsageLog).values({
      accountId: args.accountId,
      conversationId: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      promptTokens: args.usage.promptTokens,
      completionTokens: args.usage.completionTokens,
      totalTokens: args.usage.totalTokens,
    })
  } catch (err) {
    console.error('[ai usage] log insert failed:', err)
  }
}
