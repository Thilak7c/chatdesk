import { and, eq } from 'drizzle-orm'

import type { DbOrTx } from '@/db'
import { contacts, notifications, profiles } from '@/db/schema'
import { emitNotificationEvent } from '@/lib/socket'

/**
 * Notify an agent that a conversation was assigned to them. Call after
 * any write that changes `conversations.assigned_agent_id` (agent
 * reassignment, AI handoff, automation `assign_conversation` step).
 *
 * No-op when the assignee is unchanged, cleared, or is the actor
 * themself (self-assignment needs no notification). Never throws — a
 * notification failure must not undo or fail the assignment itself.
 */
export async function notifyConversationAssigned(
  db: DbOrTx,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    newAssigneeId: string | null
    previousAssigneeId: string | null
    /** users.id of whoever made the change; null for system actions (AI, automations). */
    actorUserId: string | null
  },
): Promise<void> {
  const { newAssigneeId, previousAssigneeId, actorUserId } = args
  if (!newAssigneeId || newAssigneeId === previousAssigneeId) return
  if (actorUserId && actorUserId === newAssigneeId) return

  try {
    const [contact] = await db
      .select({ name: contacts.name, phone: contacts.phone })
      .from(contacts)
      .where(eq(contacts.id, args.contactId))
      .limit(1)
    const contactName = contact?.name?.trim() || contact?.phone || 'a contact'

    let actorName = 'Someone'
    if (actorUserId) {
      const [actor] = await db
        .select({ fullName: profiles.fullName })
        .from(profiles)
        .where(and(eq(profiles.userId, actorUserId), eq(profiles.accountId, args.accountId)))
        .limit(1)
      if (actor?.fullName) actorName = actor.fullName
    }

    await db.insert(notifications).values({
      accountId: args.accountId,
      userId: newAssigneeId,
      type: 'conversation_assigned',
      conversationId: args.conversationId,
      contactId: args.contactId,
      actorUserId,
      title: 'New conversation assigned',
      body: `${actorName} assigned you a conversation with ${contactName}`,
    })
    emitNotificationEvent(newAssigneeId)
  } catch (err) {
    console.error('[notifications] assignment notification failed:', err)
  }
}

/** True when `userId` is a member of `accountId` (valid assignment target). */
export async function isAccountMember(
  db: DbOrTx,
  accountId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), eq(profiles.accountId, accountId)))
    .limit(1)
  return rows.length > 0
}
