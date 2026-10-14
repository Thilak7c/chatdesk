// ============================================================
// Broadcast delivery counters.
//
// `broadcasts.{sent,delivered,read,replied,failed}_count` are
// aggregates over the broadcast's recipients. Every change to a
// recipient's `status` MUST go through `updateRecipients` below, which
// applies the status change and the matching counter deltas in one
// transaction — so counts can't drift from the recipient rows, even
// under concurrent webhook deliveries.
//
// Statuses are cumulative: a `read` recipient also counts as sent and
// delivered. `pending` counts toward nothing.
// ============================================================

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { DbOrTx, Tx } from '@/db';
import { broadcastRecipients, broadcasts } from '@/db/schema';

export const RECIPIENT_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export function isRecipientStatus(value: unknown): value is RecipientStatus {
  return typeof value === 'string' && (RECIPIENT_STATUSES as readonly string[]).includes(value);
}

type CounterColumn = 'sentCount' | 'deliveredCount' | 'readCount' | 'repliedCount' | 'failedCount';

/** Which counters a recipient in `status` contributes to. */
export function countersForStatus(status: string): CounterColumn[] {
  switch (status) {
    case 'sent':
      return ['sentCount'];
    case 'delivered':
      return ['sentCount', 'deliveredCount'];
    case 'read':
      return ['sentCount', 'deliveredCount', 'readCount'];
    case 'replied':
      return ['sentCount', 'deliveredCount', 'readCount', 'repliedCount'];
    case 'failed':
      return ['failedCount'];
    default:
      return [];
  }
}

/** Run `fn` in a transaction, reusing the caller's if `db` already is one. */
async function inTransaction<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ('rollback' in db) return fn(db as Tx);
  return db.transaction(fn);
}

export type RecipientUpdate = Partial<
  Pick<
    typeof broadcastRecipients.$inferInsert,
    | 'status'
    | 'sentAt'
    | 'deliveredAt'
    | 'readAt'
    | 'repliedAt'
    | 'errorMessage'
    | 'whatsappMessageId'
    | 'templateParams'
  >
>;

/**
 * Update every recipient matching `where` with `set`, adjusting the
 * parent broadcasts' counters for any status that changed. Returns
 * the updated rows (id, broadcast id, old and new status).
 */
export async function updateRecipients(
  db: DbOrTx,
  where: SQL,
  set: RecipientUpdate,
): Promise<{ id: string; broadcastId: string; oldStatus: string; newStatus: string }[]> {
  return inTransaction(db, async (tx) => {
    // Lock first so the old status we read is the one we replace.
    const before = await tx
      .select({
        id: broadcastRecipients.id,
        broadcastId: broadcastRecipients.broadcastId,
        status: broadcastRecipients.status,
      })
      .from(broadcastRecipients)
      .where(where)
      .for('update');
    if (before.length === 0) return [];

    const ids = before.map((r) => r.id);
    const after = await tx
      .update(broadcastRecipients)
      .set(set)
      .where(inArray(broadcastRecipients.id, ids))
      .returning({ id: broadcastRecipients.id, status: broadcastRecipients.status });
    const newStatusById = new Map(after.map((r) => [r.id, r.status]));

    // Net delta per broadcast per counter.
    const deltas = new Map<string, Map<CounterColumn, number>>();
    const changed = before.map((r) => ({
      id: r.id,
      broadcastId: r.broadcastId,
      oldStatus: r.status,
      newStatus: newStatusById.get(r.id) ?? r.status,
    }));
    for (const r of changed) {
      if (r.oldStatus === r.newStatus) continue;
      const d = deltas.get(r.broadcastId) ?? new Map<CounterColumn, number>();
      for (const c of countersForStatus(r.oldStatus)) d.set(c, (d.get(c) ?? 0) - 1);
      for (const c of countersForStatus(r.newStatus)) d.set(c, (d.get(c) ?? 0) + 1);
      deltas.set(r.broadcastId, d);
    }

    for (const [broadcastId, d] of deltas) {
      const patch: Record<string, SQL> = {};
      for (const [col, delta] of d) {
        if (delta === 0) continue;
        patch[col] = sql`greatest(0, ${broadcasts[col]} + ${delta})`;
      }
      if (Object.keys(patch).length === 0) continue;
      await tx.update(broadcasts).set(patch).where(eq(broadcasts.id, broadcastId));
    }

    return changed;
  });
}

/** Convenience: update a single recipient by id. */
export async function updateRecipient(db: DbOrTx, recipientId: string, set: RecipientUpdate) {
  const [row] = await updateRecipients(db, eq(broadcastRecipients.id, recipientId), set);
  return row ?? null;
}

/**
 * Recompute a broadcast's counters from its recipient rows. The
 * incremental path keeps them right; this is the repair tool.
 */
export async function recomputeBroadcastCounts(db: DbOrTx, broadcastId: string): Promise<void> {
  const r = broadcastRecipients;
  const [agg] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${r.status} in ('sent','delivered','read','replied'))`.mapWith(Number),
      delivered: sql<number>`count(*) filter (where ${r.status} in ('delivered','read','replied'))`.mapWith(Number),
      read: sql<number>`count(*) filter (where ${r.status} in ('read','replied'))`.mapWith(Number),
      replied: sql<number>`count(*) filter (where ${r.status} = 'replied')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${r.status} = 'failed')`.mapWith(Number),
    })
    .from(r)
    .where(and(eq(r.broadcastId, broadcastId)));
  await db
    .update(broadcasts)
    .set({
      sentCount: agg?.sent ?? 0,
      deliveredCount: agg?.delivered ?? 0,
      readCount: agg?.read ?? 0,
      repliedCount: agg?.replied ?? 0,
      failedCount: agg?.failed ?? 0,
    })
    .where(eq(broadcasts.id, broadcastId));
}
