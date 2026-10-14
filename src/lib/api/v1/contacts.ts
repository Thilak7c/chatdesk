// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (the same one the webhook and send path use), and
// one tag-sync routine.
// ============================================================

import { and, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { containsPattern } from '@/db/like';
import { contacts, contactTags, tags } from '@/db/schema';
import {
  findOrCreateContact as findOrCreateContactRow,
  resolveAuditUserId as resolveAuditUserIdRow,
} from '@/lib/contacts/find-or-create';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { keysetWhere, type Cursor } from './pagination';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type ContactRow = typeof contacts.$inferSelect;
type TagSummary = { id: string; name: string; color: string };

/** Public contact shape from a contacts row + its tags. */
export function serializeContact(row: ContactRow, rowTags: TagSummary[]): ApiContact {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name ?? null,
    email: row.email ?? null,
    company: row.company ?? null,
    avatar_url: row.avatarUrl ?? null,
    tags: rowTags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Load the tags for a set of contacts in one query. */
async function tagsByContact(
  db: DbOrTx,
  contactIds: string[]
): Promise<Map<string, TagSummary[]>> {
  const out = new Map<string, TagSummary[]>();
  if (contactIds.length === 0) return out;
  const rows = await db
    .select({
      contactId: contactTags.contactId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, contactIds));
  for (const r of rows) {
    const list = out.get(r.contactId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.contactId, list);
  }
  return out;
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human: the WhatsApp config owner,
 * falling back to the account owner.
 */
export async function resolveAuditUserId(
  db: DbOrTx,
  accountId: string
): Promise<string> {
  try {
    return await resolveAuditUserIdRow(db, accountId);
  } catch {
    throw new ContactError('Account owner could not be resolved', 500);
  }
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Find (by fuzzy phone match) or create a contact in `accountId`.
 * Returns the contact id and whether it was created.
 */
export async function findOrCreateContact(
  db: DbOrTx,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  try {
    const { contact, created } = await findOrCreateContactRow(db, {
      accountId,
      auditUserId,
      phone: sanitized,
      name: input.name ?? sanitized,
      email: input.email ?? null,
      company: input.company ?? null,
    });
    return { id: contact.id, created };
  } catch (error) {
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }
}

/**
 * Replace a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing tags are created). Pass `[]` to clear all tags.
 * Reuses `resolveImportTagIds` so API and CSV-import tag handling stay
 * consistent.
 */
export async function setContactTags(
  db: DbOrTx,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId: auditUserId,
    tagNames,
    canCreateTags: true,
  });
  const desired = new Set(tagIdByKey.values());

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay.
  let current: { tagId: string }[];
  try {
    current = await db
      .select({ tagId: contactTags.tagId })
      .from(contactTags)
      .where(eq(contactTags.contactId, contactId));
  } catch {
    throw new ContactError('Failed to read contact tags', 500);
  }
  const existing = new Set(current.map((r) => r.tagId));

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    try {
      await db
        .delete(contactTags)
        .where(and(eq(contactTags.contactId, contactId), inArray(contactTags.tagId, toRemove)));
    } catch {
      throw new ContactError('Failed to update contact tags', 500);
    }
  }
  for (const tagId of toAdd) {
    try {
      await addContactTagAndDispatch({ db, accountId, contactId, tagId });
    } catch (error) {
      console.error('[api/v1/contacts] tag add failed:', error);
      throw new ContactError('Failed to update contact tags', 500);
    }
  }
}

/** Fetch + serialize a single contact scoped to the account, or null. */
export async function getContactById(
  db: DbOrTx,
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!row) return null;
  const t = await tagsByContact(db, [row.id]);
  return serializeContact(row, t.get(row.id) ?? []);
}

/**
 * One page of contacts, newest first, over-fetched by one row so the
 * caller's `buildPage` can tell whether another page exists. `search`
 * matches name/phone/email; `tagId` keeps only contacts with that tag.
 */
export async function listContacts(
  db: DbOrTx,
  accountId: string,
  opts: { limit: number; cursor: Cursor | null; search?: string | null; tagId?: string | null }
): Promise<ApiContact[]> {
  const conditions: (SQL | undefined)[] = [
    eq(contacts.accountId, accountId),
    keysetWhere(opts.cursor, contacts.createdAt, contacts.id),
  ];
  if (opts.search) {
    const term = containsPattern(opts.search);
    conditions.push(
      or(ilike(contacts.name, term), ilike(contacts.phone, term), ilike(contacts.email, term))
    );
  }
  if (opts.tagId) {
    conditions.push(
      inArray(
        contacts.id,
        db
          .select({ id: contactTags.contactId })
          .from(contactTags)
          .where(eq(contactTags.tagId, opts.tagId))
      )
    );
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(desc(contacts.createdAt), desc(contacts.id))
    .limit(opts.limit + 1);

  const t = await tagsByContact(db, rows.map((r) => r.id));
  return rows.map((r) => serializeContact(r, t.get(r.id) ?? []));
}
