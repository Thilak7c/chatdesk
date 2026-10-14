// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed) and `?contact_id=`. Each conversation embeds its contact +
// tags.
// ============================================================

import { desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { conversations } from '@/db/schema';
import { requireApiKey } from '@/lib/auth/api-context';
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetWhere, buildPage } from '@/lib/api/v1/pagination';
import { fetchConversations } from '@/lib/inbox/conversation-query';
import { serializeConversation } from '@/lib/api/v1/conversations';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');

    const rows = await fetchConversations(db, {
      accountId: ctx.accountId,
      where: [
        status ? eq(conversations.status, status) : undefined,
        contactId ? eq(conversations.contactId, contactId) : undefined,
        keysetWhere(cursor, conversations.createdAt, conversations.id),
      ],
      orderBy: [desc(conversations.createdAt), desc(conversations.id)],
      limit: limit + 1,
    });

    const { items, nextCursor } = buildPage(rows, limit);
    return okList(items.map(serializeConversation), nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
