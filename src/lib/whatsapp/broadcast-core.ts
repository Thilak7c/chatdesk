// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import { and, count, eq } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { broadcastRecipients, broadcasts, whatsappConfig } from '@/db/schema';
import { updateRecipient } from '@/lib/broadcasts/counters';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: DbOrTx,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  const [config] = await db
    .select()
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, accountId))
    .limit(1);
  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const accessToken = decrypt(config.accessToken);

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients in ONE transaction: if the
  // recipient insert fails, the parent must not survive as an orphaned
  // 'sending' campaign with no delivery plan. Recipients
  // start 'pending', which contributes to no counter, so the counts
  // start at zero and are advanced by updateRecipients() as deliveries
  // land. `rejected` phones have no recipient row; they are reported to
  // the caller in the POST response, not in these persisted counts.
  let broadcastId: string;
  let createdRows: { id: string; contactId: string | null }[];
  try {
    ({ broadcastId, createdRows } = await db.transaction(async (tx) => {
      const [b] = await tx
        .insert(broadcasts)
        .values({
          accountId,
          userId: auditUserId,
          name: name || `API broadcast (${templateName})`,
          templateName,
          templateLanguage: resolvedTemplate.language,
          status: 'sending',
          totalRecipients: deduped.length,
        })
        .returning({ id: broadcasts.id });
      const rows = await tx
        .insert(broadcastRecipients)
        .values(
          deduped.map((r) => ({
            broadcastId: b.id,
            contactId: r.contactId,
            status: 'pending',
            // Frozen per-recipient params — without them a resume of
            // this broadcast has no way to reconstruct {{1}}.
            templateParams: r.params,
          }))
        )
        .returning({ id: broadcastRecipients.id, contactId: broadcastRecipients.contactId });
      return { broadcastId: b.id, createdRows: rows };
    }));
  } catch (createErr) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map((row) => {
    const r = byContact.get(row.contactId!)!;
    return { recipientRowId: row.id, phone: r.phone, params: r.params };
  });

  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phoneNumberId,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are maintained by
 * updateRecipient() (src/lib/broadcasts/counters.ts) as each recipient
 * row changes, and later Meta delivery/read webhooks keep advancing
 * them. Only the terminal `status` is written directly here.
 */
export async function deliverBroadcast(
  db: DbOrTx,
  plan: BroadcastPlan
): Promise<void> {
  for (const recipient of plan.planned) {
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      await updateRecipient(db, recipient.recipientRowId, {
        status: 'sent',
        sentAt: new Date(),
        whatsappMessageId: sentMessageId,
        errorMessage: null,
      });
    } else {
      await updateRecipient(db, recipient.recipientRowId, {
        status: 'failed',
        errorMessage: lastError || 'Unknown error',
      });
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts are maintained by updateRecipients() — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: DbOrTx,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status?: string): Promise<number> => {
    const [row] = await db
      .select({ n: count() })
      .from(broadcastRecipients)
      .where(
        status
          ? and(eq(broadcastRecipients.broadcastId, broadcastId), eq(broadcastRecipients.status, status))
          : eq(broadcastRecipients.broadcastId, broadcastId)
      );
    return row?.n ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const total = await countWhere();

  await db
    .update(broadcasts)
    .set({ status: failed > 0 && failed === total ? 'failed' : 'sent' })
    .where(eq(broadcasts.id, broadcastId));
}
