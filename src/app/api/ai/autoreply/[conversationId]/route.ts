import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { conversations } from '@/db/schema'
import { notifyConversationAssigned } from '@/lib/conversations/assign'
import { publishConversation } from '@/lib/socket'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow).
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 *
 * Every query is scoped to the caller's account, so a conversation
 * outside it simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    // Confirm the conversation is in the caller's account before writing.
    const [conv] = await db
      .select({ id: conversations.id, assignedAgentId: conversations.assignedAgentId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      .limit(1)
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const update: Partial<typeof conversations.$inferInsert> = { aiAutoreplyDisabled: paused }

    if (paused) {
      if (assignToMe) update.assignedAgentId = userId
    } else {
      // Resuming hands the thread *back to the bot*. Clear the pause and
      // the handoff note, and — crucially — release ANY assignment, not
      // just the caller's own: the auto-reply eligibility gate stands
      // down whenever a human is assigned, so leaving a stale assignee
      // (e.g. the agent a prior handoff routed to) would silently keep
      // the bot muted and make "Resume AI" a no-op. This is the explicit
      // choice to let the bot own the thread again.
      update.assignedAgentId = null
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale — it's
      // a human choosing to re-engage the assistant.
      update.aiReplyCount = 0
      update.aiHandoffSummary = null
    }

    const [updated] = await db
      .update(conversations)
      .set(update)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      .returning()
    if (updated) {
      publishConversation(accountId, 'UPDATE', updated)
      if (update.assignedAgentId) {
        await notifyConversationAssigned(db, {
          accountId,
          conversationId,
          contactId: updated.contactId,
          newAssigneeId: update.assignedAgentId,
          previousAssigneeId: conv.assignedAgentId,
          actorUserId: userId,
        })
      }
    }

    return NextResponse.json({ success: true, paused })
  } catch (err) {
    return toErrorResponse(err)
  }
}
