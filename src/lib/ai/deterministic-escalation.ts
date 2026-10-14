import type { DbOrTx } from '@/db'
import type { AiConfig } from './types'
import { retrieveKnowledge, type KnowledgeResult } from './knowledge'

type EscalationResult =
  | { escalate: true; reason: string }
  | { escalate: false; knowledge: KnowledgeResult }

/**
 * Runs the two non-LLM escalation checks and, when neither fires, returns
 * the knowledge-base retrieval it had to do anyway — so callers don't
 * pay for a second embedding + database round trip to get the chunks for the
 * prompt.
 *
 * Order matters: hard-escalate keywords are checked first and are pure
 * string matching (cheap, no network call). The confidence check runs
 * second because it requires the knowledge retrieval to have happened.
 *
 * Both checks are opt-in per account (empty keyword list / null
 * threshold = check never fires), so this is a no-op for accounts that
 * haven't configured either — existing installs are unaffected.
 */
export async function evaluateDeterministicEscalation(args: {
  db: DbOrTx
  accountId: string
  config: AiConfig
  inbound: string
}): Promise<EscalationResult> {
  const { db, accountId, config, inbound } = args

  const keywordHit = matchHardEscalateKeyword(inbound, config.hardEscalateKeywords)
  if (keywordHit) {
    return {
      escalate: true,
      reason: `hard-escalate keyword matched: "${keywordHit}"`,
    }
  }

  const knowledge = await retrieveKnowledge(db, accountId, config, inbound)

  // Only enforceable when there's both a configured threshold AND a
  // semantic score to compare it against (lexical-only retrieval has no
  // comparable distance). Absent either, we fall through to the LLM's
  // own [[HANDOFF]] judgment as the sole safety net — same behaviour as
  // before this change.
  if (config.confidenceThreshold != null && knowledge.bestDistance != null) {
    if (knowledge.bestDistance > config.confidenceThreshold) {
      return {
        escalate: true,
        reason: `low knowledge-base confidence (distance ${knowledge.bestDistance.toFixed(3)} > threshold ${config.confidenceThreshold.toFixed(3)})`,
      }
    }
  }

  return { escalate: false, knowledge }
}

/**
 * Case-insensitive substring match against the operator's configured
 * keyword list. Returns the matched keyword (for the audit note) or
 * null. Deliberately simple/literal — no fuzzy matching or stemming, so
 * behaviour is predictable and easy for an operator to reason about
 * when reviewing why a conversation escalated.
 */
function matchHardEscalateKeyword(
  message: string,
  keywords: string[],
): string | null {
  if (!message || keywords.length === 0) return null
  const lower = message.toLowerCase()
  for (const kw of keywords) {
    const needle = kw.trim().toLowerCase()
    if (needle && lower.includes(needle)) return kw
  }
  return null
}
