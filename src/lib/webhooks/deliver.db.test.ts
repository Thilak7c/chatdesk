import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Control the SSRF guard per-test.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { db } from '@/db';
import { webhookEndpoints } from '@/db/schema';
import { encrypt } from '@/lib/whatsapp/encryption';
import { createAccount, describeDb } from '@/test/factories';
import { dispatchWebhookEvent, MAX_CONSECUTIVE_FAILURES } from './deliver';
import { isDeliverableUrl } from './ssrf';

async function seedEndpoint(over: Partial<typeof webhookEndpoints.$inferInsert> = {}) {
  const { account } = await createAccount();
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      accountId: account.id,
      url: 'https://a.test/hook',
      secret: encrypt('whsec_test'),
      events: ['message.received'],
      ...over,
    })
    .returning();
  return { accountId: account.id, endpoint: row };
}

const reload = async (id: string) =>
  (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)))[0];

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describeDb('dispatchWebhookEvent', () => {
  it('signs + POSTs (no redirect follow) and resets the failure streak on success', async () => {
    const { accountId, endpoint } = await seedEndpoint({ failureCount: 4 });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await dispatchWebhookEvent(db, accountId, 'message.received', { x: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Chatdesk-Event']).toBe('message.received');
    expect(opts.headers['X-Chatdesk-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);

    const after = await reload(endpoint.id);
    expect(after.failureCount).toBe(0);
    expect(after.lastDeliveryAt).not.toBeNull();
  });

  it('counts failures atomically and auto-disables at the threshold', async () => {
    const { accountId, endpoint } = await seedEndpoint({
      failureCount: MAX_CONSECUTIVE_FAILURES - 2,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));

    // Two concurrent failing deliveries must both be counted.
    await Promise.all([
      dispatchWebhookEvent(db, accountId, 'message.received', {}),
      dispatchWebhookEvent(db, accountId, 'message.received', {}),
    ]);

    const after = await reload(endpoint.id);
    expect(after.failureCount).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(after.isActive).toBe(false);
  });

  it('blocks a non-public target (SSRF guard) without fetching, and counts it', async () => {
    const { accountId, endpoint } = await seedEndpoint({ url: 'https://127.0.0.1/hook' });
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await dispatchWebhookEvent(db, accountId, 'message.received', {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await reload(endpoint.id)).failureCount).toBe(1);
  });

  it('skips endpoints that are inactive, unsubscribed, or in another account', async () => {
    const { accountId } = await seedEndpoint({ isActive: false });
    await seedEndpoint(); // another account
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await dispatchWebhookEvent(db, accountId, 'message.received', {});
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {});

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
