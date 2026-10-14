// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { conversations } from '@/db/schema';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { fetchConversations } from '@/lib/inbox/conversation-query';
import { serializeConversation } from '@/lib/api/v1/conversations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const [conversation] = await fetchConversations(db, {
      accountId: ctx.accountId,
      where: [eq(conversations.id, id)],
      limit: 1,
    });
    if (!conversation) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(conversation));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
