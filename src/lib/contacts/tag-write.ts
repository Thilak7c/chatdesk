import { and, eq } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { contacts, contactTags, tags } from '@/db/schema';

export class ContactTagWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ContactTagWriteError';
    this.status = status;
  }
}

interface ContactTagWriteInput {
  accountId: string;
  contactId: string;
  tagId: string;
}

async function assertContactAndTagOwnership(
  db: DbOrTx,
  input: ContactTagWriteInput
): Promise<void> {
  let contactRows: unknown[];
  let tagRows: unknown[];
  try {
    [contactRows, tagRows] = await Promise.all([
      db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1),
      db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, input.tagId), eq(tags.accountId, input.accountId)))
        .limit(1),
    ]);
  } catch {
    throw new ContactTagWriteError('Could not verify contact tag ownership');
  }

  if (contactRows.length === 0) {
    throw new ContactTagWriteError('Contact not found', 404);
  }
  if (tagRows.length === 0) {
    throw new ContactTagWriteError('Tag not found', 404);
  }
}

/**
 * Add a tag exactly once. The unique constraint on
 * (contact_id, tag_id) is the concurrency-safe source of truth: a
 * duplicate insert is a no-op and must not emit a tag_added event.
 */
export async function addContactTagIfAbsent(
  db: DbOrTx,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  try {
    const inserted = await db
      .insert(contactTags)
      .values({ contactId: input.contactId, tagId: input.tagId })
      .onConflictDoNothing()
      .returning({ id: contactTags.id });
    return inserted.length > 0;
  } catch (error) {
    throw new ContactTagWriteError(
      `Failed to add contact tag: ${(error as Error).message}`
    );
  }
}

export async function removeContactTag(
  db: DbOrTx,
  input: ContactTagWriteInput
): Promise<void> {
  await assertContactAndTagOwnership(db, input);

  try {
    await db
      .delete(contactTags)
      .where(and(eq(contactTags.contactId, input.contactId), eq(contactTags.tagId, input.tagId)));
  } catch (error) {
    throw new ContactTagWriteError(
      `Failed to remove contact tag: ${(error as Error).message}`
    );
  }
}
