// ============================================================
// Outbound webhook delivery.
//
// `dispatchWebhookEvent` finds the account's active endpoints
// subscribed to an event, signs one JSON payload, and POSTs it to
// each in parallel. It is best-effort and never throws — callers fire
// it from the inbound webhook's `after()` block, where a failed
// delivery must not affect the 200 OK returned to Meta.
//
// Delivery semantics (documented in docs/public-api.md):
//   - At-most-once per event, single attempt with a short timeout.
//   - Each consecutive failure bumps `failure_count`; once it crosses
//     MAX_CONSECUTIVE_FAILURES the endpoint is auto-disabled
//     (`is_active = false`) so a dead sink stops being hit. A success
//     resets the counter and stamps `last_delivery_at`.
//   - Durable retry-with-backoff would need a queue/worker (a
//     follow-up); in-process retries inside `after()` would burn the
//     route's duration budget without a real durability guarantee.
// ============================================================

import { randomUUID } from 'node:crypto';

import { and, arrayContains, eq, sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { webhookEndpoints } from '@/db/schema';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { WebhookEvent } from '@/lib/webhooks/events';

/** Per-endpoint HTTP timeout. Kept short — this runs in `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

/**
 * Deliver `event` (+ `data`) to every active endpoint of `accountId`
 * subscribed to it. Never throws.
 */
export async function dispatchWebhookEvent(
  db: DbOrTx,
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  try {
    const rows: EndpointRow[] = await db
      .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, secret: webhookEndpoints.secret })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.accountId, accountId),
          eq(webhookEndpoints.isActive, true),
          arrayContains(webhookEndpoints.events, [event]),
        ),
      );

    if (rows.length === 0) return;

    // Sign the exact bytes we send so a receiver can recompute the
    // HMAC over the raw request body. `id` is a per-delivery uuid the
    // receiver can dedupe on (deliveries are at-least-once and may
    // repeat / arrive out of order).
    const payload = JSON.stringify({
      id: randomUUID(),
      event,
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data,
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    await Promise.allSettled(
      rows.map((row) =>
        deliverOne(db, row, event, payload, tsSeconds)
      )
    );
  } catch (err) {
    // Never let a delivery problem bubble into the webhook response.
    console.error('[webhooks] dispatch failed:', err);
  }
}

async function deliverOne(
  db: DbOrTx,
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number
): Promise<void> {
  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address. Counts as a failure so a
  // misconfigured internal URL surfaces and eventually auto-disables.
  if (!(await isDeliverableUrl(row.url))) {
    console.warn('[webhooks] refusing non-public delivery target for', row.id);
    await recordFailure(db, row);
    return;
  }

  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch (err) {
    // A row whose secret can't be decrypted can never produce a valid
    // signature — count it as a failure so it eventually auto-disables.
    console.error('[webhooks] secret decrypt failed for', row.id, err);
    await recordFailure(db, row);
    return;
  }

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chatdesk-Event': event,
        'X-Chatdesk-Webhook-Id': row.id,
        'X-Chatdesk-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, bypassing the SSRF check above. A 3xx is a
      // misconfiguration; treat it as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    // Success: clear the failure streak.
    await db
      .update(webhookEndpoints)
      .set({ failureCount: 0, lastDeliveryAt: new Date() })
      .where(eq(webhookEndpoints.id, row.id));
  } catch (err) {
    console.warn(
      `[webhooks] delivery to ${row.id} failed:`,
      err instanceof Error ? err.message : err
    );
    await recordFailure(db, row);
  }
}

async function recordFailure(db: DbOrTx, row: EndpointRow): Promise<void> {
  // Atomic increment (+ auto-disable at the threshold) in one UPDATE —
  // a read-modify-write here would lose increments when two deliveries
  // to the same endpoint run concurrently (e.g. conversation.created +
  // message.received for one inbound message), so a dead endpoint
  // might never reach the disable threshold.
  try {
    await db
      .update(webhookEndpoints)
      .set({
        failureCount: sql`${webhookEndpoints.failureCount} + 1`,
        isActive: sql`case when ${webhookEndpoints.failureCount} + 1 >= ${MAX_CONSECUTIVE_FAILURES} then false else ${webhookEndpoints.isActive} end`,
      })
      .where(eq(webhookEndpoints.id, row.id));
  } catch (error) {
    console.error('[webhooks] recording failure failed for', row.id, error);
  }
}
