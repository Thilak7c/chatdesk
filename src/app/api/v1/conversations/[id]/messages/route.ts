// ============================================================
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, keyset-paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { conversations, messages } from '@/db/schema';
import { toSnake } from '@/db/serialize';
import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetWhere, buildPage } from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import type { Message } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    // Gate on account ownership of the conversation first.
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .limit(1);
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    const rows = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.conversationId, id), keysetWhere(cursor, messages.createdAt, messages.id))
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const { items, nextCursor } = buildPage(rows.map(toSnake), limit);
    return okList(
      items.map((m) => serializeMessage(m as unknown as Message)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
