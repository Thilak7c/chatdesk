// ============================================================
// GET  /api/v1/webhooks — list webhook endpoints (scope: webhooks:manage)
// POST /api/v1/webhooks — register an endpoint    (scope: webhooks:manage)
//
// POST returns the signing `secret` in plaintext exactly once — store
// it to verify the `X-Chatdesk-Signature` on deliveries. ChatDesk keeps only
// an encrypted copy and can never show it again.
// ============================================================

import { desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { webhookEndpoints } from '@/db/schema';
import { toSnake } from '@/db/serialize';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');

    const rows = await db
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.accountId, ctx.accountId))
      .orderBy(desc(webhookEndpoints.createdAt));

    // The roster is small and settings-class — return it whole (the
    // list envelope's cursor is always null here).
    return okList(rows.map((r) => serializeWebhookEndpoint(toSnake(r))), null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const url = normalizeWebhookUrl(body.url);
    if (!url) {
      return fail('bad_request', "'url' must be a valid https:// URL", 400);
    }

    const events = normalizeEvents(body.events);
    if (!events) {
      return fail(
        'bad_request',
        "'events' must be a non-empty array of known event names",
        400
      );
    }

    const secret = generateWebhookSecret();

    const [created] = await db
      .insert(webhookEndpoints)
      .values({
        accountId: ctx.accountId,
        createdBy: ctx.createdBy,
        url,
        secret: encrypt(secret),
        events,
      })
      .returning(WEBHOOK_PUBLIC_COLUMNS);

    // Secret shown exactly once.
    return ok({ ...serializeWebhookEndpoint(toSnake(created)), secret }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
