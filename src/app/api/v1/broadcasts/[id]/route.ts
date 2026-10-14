// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:send).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `status` moves 'sending' → 'sent'; the delivered/read
// counts continue to climb as Meta delivery webhooks arrive.
// Account-scoped: a foreign id → 404.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { broadcasts } from '@/db/schema';
import { toSnake } from '@/db/serialize';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    const [data] = await db
      .select({
        id: broadcasts.id,
        name: broadcasts.name,
        templateName: broadcasts.templateName,
        templateLanguage: broadcasts.templateLanguage,
        status: broadcasts.status,
        totalRecipients: broadcasts.totalRecipients,
        sentCount: broadcasts.sentCount,
        deliveredCount: broadcasts.deliveredCount,
        readCount: broadcasts.readCount,
        repliedCount: broadcasts.repliedCount,
        failedCount: broadcasts.failedCount,
        createdAt: broadcasts.createdAt,
        updatedAt: broadcasts.updatedAt,
      })
      .from(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1);
    if (!data) return fail('not_found', 'Broadcast not found', 404);

    return ok(toSnake(data));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
