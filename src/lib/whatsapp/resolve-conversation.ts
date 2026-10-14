// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It reuses the exact find-or-create the inbound webhook uses
// (src/lib/contacts/find-or-create.ts), so a contact created via the
// API is indistinguishable from one created by an inbound message.
// ============================================================

import { eq } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { whatsappConfig } from '@/db/schema';
import { findOrCreateContact, findOrCreateConversation } from '@/lib/contacts/find-or-create';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`. Throws `SendMessageError` (shared with the send core,
 * so the route maps one error family) on a bad phone, a missing
 * WhatsApp config, or a DB failure.
 */
export async function resolveConversationByPhone(
  db: DbOrTx,
  accountId: string,
  phone: string,
  name?: string | null
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  // Fail fast (and create nothing) when the account has no WhatsApp
  // connected — the same error the send would raise anyway.
  const [config] = await db
    .select({ id: whatsappConfig.id })
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, accountId))
    .limit(1);
  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  try {
    const { contact, created } = await findOrCreateContact(db, {
      accountId,
      auditUserId: ownerUserId,
      phone: sanitized,
      name: name || sanitized,
      refreshName: Boolean(name),
    });
    const { conversation } = await findOrCreateConversation(db, {
      accountId,
      contactId: contact.id,
      auditUserId: ownerUserId,
    });
    return { conversationId: conversation.id, contactId: contact.id, contactCreated: created };
  } catch (err) {
    console.error('[resolve-conversation] find-or-create failed:', err);
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }
}
