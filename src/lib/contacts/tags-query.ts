import { eq, inArray } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { contactTags, tags } from '@/db/schema';

export interface TagSummary {
  id: string;
  name: string;
  color: string;
}

/** Tags for a set of contacts in one query, keyed by contact id. */
export async function tagsByContactIds(
  db: DbOrTx,
  contactIds: string[],
): Promise<Map<string, TagSummary[]>> {
  const out = new Map<string, TagSummary[]>();
  const unique = [...new Set(contactIds)];
  if (unique.length === 0) return out;
  const rows = await db
    .select({ contactId: contactTags.contactId, id: tags.id, name: tags.name, color: tags.color })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, unique));
  for (const r of rows) {
    const list = out.get(r.contactId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.contactId, list);
  }
  return out;
}
