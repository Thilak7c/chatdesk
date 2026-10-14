// ============================================================
// Find-or-create for contacts and conversations — the one
// implementation shared by the inbound WhatsApp webhook, the public
// API, and send-by-phone, so a contact created by any path is
// indistinguishable from one created by another.
//
// Both rely on a unique index as the concurrency backstop:
//   contacts       (account_id, phone_normalized)
//   conversations  (account_id, contact_id)
// An insert that loses a race does nothing (ON CONFLICT DO NOTHING)
// and we re-read the winner instead of failing.
// ============================================================

import { and, asc, eq } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { accounts, contacts, conversations, whatsappConfig } from '@/db/schema';
import { findExistingContact } from './dedupe';

export type ContactRow = typeof contacts.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;

/**
 * The audit `user_id` for rows created without a logged-in human
 * (inbound webhook, public API): the WhatsApp config owner, falling
 * back to the account owner when WhatsApp isn't connected yet.
 */
export async function resolveAuditUserId(db: DbOrTx, accountId: string): Promise<string> {
  const [config] = await db
    .select({ userId: whatsappConfig.userId })
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, accountId))
    .limit(1);
  if (config) return config.userId;

  const [account] = await db
    .select({ ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new Error(`Account ${accountId} not found`);
  return account.ownerUserId;
}

/**
 * Find a contact by (fuzzy) phone match, or create it. `phone` must
 * already be sanitized. When the contact exists and `refreshName` is
 * set, a changed non-empty `name` is written back (the webhook keeps
 * WhatsApp profile names fresh this way).
 */
export async function findOrCreateContact(
  db: DbOrTx,
  args: {
    accountId: string;
    auditUserId: string;
    phone: string;
    name?: string | null;
    email?: string | null;
    company?: string | null;
    refreshName?: boolean;
  },
): Promise<{ contact: ContactRow; created: boolean }> {
  const existing = await findExistingContact(db, args.accountId, args.phone);
  if (existing) {
    if (args.refreshName && args.name && args.name !== existing.name) {
      const [updated] = await db
        .update(contacts)
        .set({ name: args.name })
        .where(eq(contacts.id, existing.id))
        .returning();
      return { contact: updated ?? existing, created: false };
    }
    return { contact: existing, created: false };
  }

  const [created] = await db
    .insert(contacts)
    .values({
      accountId: args.accountId,
      userId: args.auditUserId,
      phone: args.phone,
      name: args.name || args.phone,
      email: args.email ?? null,
      company: args.company ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { contact: created, created: true };

  // Lost the race to a concurrent create — resolve the winner.
  const raced = await findExistingContact(db, args.accountId, args.phone);
  if (!raced) throw new Error('Contact insert conflicted but no matching contact was found');
  return { contact: raced, created: false };
}

/** The single conversation for (account, contact), created if missing. */
export async function findOrCreateConversation(
  db: DbOrTx,
  args: { accountId: string; contactId: string; auditUserId: string },
): Promise<{ conversation: ConversationRow; created: boolean }> {
  const lookup = () =>
    db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, args.accountId),
          eq(conversations.contactId, args.contactId),
        ),
      )
      .orderBy(asc(conversations.createdAt))
      .limit(1);

  const [existing] = await lookup();
  if (existing) return { conversation: existing, created: false };

  const [created] = await db
    .insert(conversations)
    .values({
      accountId: args.accountId,
      userId: args.auditUserId,
      contactId: args.contactId,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { conversation: created, created: true };

  const [raced] = await lookup();
  if (!raced) throw new Error('Conversation insert conflicted but no row was found');
  return { conversation: raced, created: false };
}
