import { and, eq, inArray, lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { automations, conversations } from '@/db/schema'
import { notifyConversationAssigned } from '@/lib/conversations/assign'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { evaluateDeterministicEscalation } from './deterministic-escalation'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const autoResponders = await db
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.accountId, accountId),
          eq(automations.isActive, true),
          inArray(automations.triggerType, ['new_message_received', 'keyword_match']),
        ),
      )
      .limit(1)
    if (autoResponders.length > 0) return

    const [conv] = await db
      .select({
        assignedAgentId: conversations.assignedAgentId,
        aiAutoreplyDisabled: conversations.aiAutoreplyDisabled,
        aiReplyCount: conversations.aiReplyCount,
      })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      .limit(1)
    if (!conv) return
    if (conv.assignedAgentId) return // a human owns this thread
    if (conv.aiAutoreplyDisabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.aiReplyCount >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    const inbound = latestUserMessage(messages)

    // Stop auto-replying on this thread (sticky until re-enabled) and
    // route it to the configured handoff agent — null leaves it in the
    // shared queue. Only assigns when the thread isn't already owned:
    // never stomp an existing human assignment.
    const handOff = async (summary: string) => {
      const assignee = config.handoffAgentId && !conv.assignedAgentId ? config.handoffAgentId : null
      const [updated] = await db
        .update(conversations)
        .set({
          aiAutoreplyDisabled: true,
          aiHandoffSummary: summary,
          ...(assignee ? { assignedAgentId: assignee } : {}),
        })
        .where(eq(conversations.id, conversationId))
        .returning({ contactId: conversations.contactId })
      if (assignee && updated) {
        await notifyConversationAssigned(db, {
          accountId,
          conversationId,
          contactId: updated.contactId,
          newAssigneeId: assignee,
          previousAssigneeId: conv.assignedAgentId,
          actorUserId: null,
        })
      }
    }

    // --- Deterministic escalation checks, BEFORE any LLM call. ---
    // The LLM's own [[HANDOFF]] sentinel (below, via generateReply) is a
    // soft, self-judged signal — useful, but not something a zero-
    // hallucination policy should rely on alone. These two checks give
    // an auditable, non-LLM reason to hand off:
    //
    //   1. Hard-escalate keywords — topics the operator never wants
    //      auto-answered (legal disputes, refunds, etc.), regardless of
    //      how confident the model would be.
    //   2. Confidence threshold — the best knowledge-base match is too
    //      dissimilar to trust an answer grounded in it. Only checked
    //      when the account has an embeddings key configured (semantic
    //      distance isn't available on the lexical-only path).
    const preCheck = await evaluateDeterministicEscalation({
      db,
      accountId,
      config,
      inbound,
    })
    if (preCheck.escalate) {
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.aiReplyCount,
      })
      await handOff(`${summary} (${preCheck.reason})`)
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const { chunks: knowledge } = preCheck.knowledge

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. handOff() notifies the assigned agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.aiReplyCount,
      })
      await handOff(summary)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const claimed = await db
      .update(conversations)
      .set({ aiReplyCount: sql`${conversations.aiReplyCount} + 1` })
      .where(
        and(
          eq(conversations.id, conversationId),
          lt(conversations.aiReplyCount, config.autoReplyMaxPerConversation),
        ),
      )
      .returning({ id: conversations.id })
    if (claimed.length === 0) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
