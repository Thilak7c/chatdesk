// ============================================================
// Conversation reads shared by the dashboard inbox and the public
// API: one row per conversation with its contact (incl. tags) and the
// assignee's profile, in the snake_case `Conversation` shape from
// src/types.
// ============================================================

import { and, desc, eq, type SQL } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { contacts, conversations, profiles } from '@/db/schema';
import { tagsByContactIds } from '@/lib/contacts/tags-query';
import type { Conversation } from '@/types';

export interface ConversationQuery {
  accountId: string;
  /** Extra conditions, ANDed with the account filter. */
  where?: (SQL | undefined)[];
  orderBy?: SQL[];
  limit?: number;
  offset?: number;
}

export async function fetchConversations(
  db: DbOrTx,
  q: ConversationQuery,
): Promise<Conversation[]> {
  let query = db
    .select({ conversation: conversations, contact: contacts, assignee: profiles })
    .from(conversations)
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(
      profiles,
      and(
        eq(profiles.userId, conversations.assignedAgentId),
        eq(profiles.accountId, conversations.accountId),
      ),
    )
    .where(and(eq(conversations.accountId, q.accountId), ...(q.where ?? [])))
    .orderBy(...(q.orderBy ?? [desc(conversations.lastMessageAt)]))
    .$dynamic();
  if (q.limit !== undefined) query = query.limit(q.limit);
  if (q.offset !== undefined) query = query.offset(q.offset);
  const rows = await query;

  const tagMap = await tagsByContactIds(
    db,
    rows.flatMap((r) => (r.contact ? [r.contact.id] : [])),
  );

  return rows.map(({ conversation: c, contact, assignee }) => ({
    id: c.id,
    account_id: c.accountId,
    user_id: c.userId,
    contact_id: c.contactId,
    status: c.status,
    assigned_agent_id: c.assignedAgentId,
    last_message_text: c.lastMessageText,
    last_message_at: c.lastMessageAt?.toISOString() ?? null,
    unread_count: c.unreadCount,
    ai_autoreply_disabled: c.aiAutoreplyDisabled,
    ai_reply_count: c.aiReplyCount,
    ai_handoff_summary: c.aiHandoffSummary,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    contact: contact
      ? {
          id: contact.id,
          account_id: contact.accountId,
          user_id: contact.userId,
          phone: contact.phone,
          name: contact.name,
          email: contact.email,
          company: contact.company,
          avatar_url: contact.avatarUrl,
          created_at: contact.createdAt.toISOString(),
          updated_at: contact.updatedAt.toISOString(),
          tags: tagMap.get(contact.id) ?? [],
        }
      : undefined,
    assignee: assignee
      ? { user_id: assignee.userId, full_name: assignee.fullName, avatar_url: assignee.avatarUrl }
      : null,
  })) as unknown as Conversation[];
}
