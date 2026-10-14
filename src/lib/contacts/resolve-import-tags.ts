import { eq } from 'drizzle-orm';

import type { DbOrTx } from '@/db';
import { tags } from '@/db/schema';

const DEFAULT_TAG_COLOR = '#3b82f6';

export interface ResolveImportTagsResult {
  /** Lowercase tag name → tag id. */
  tagIdByKey: Map<string, string>;
  /** Names that could not be matched and were not created. */
  skippedNames: string[];
}

/**
 * Resolve tag names from a CSV import to tag ids. Existing account tags
 * are matched case-insensitively. Missing names are created when
 * `canCreateTags` is true (admin+); otherwise they are reported in
 * `skippedNames`.
 *
 * Unlike the manual contact form (existing tags only), import may
 * auto-create missing tag definitions for admin+ callers.
 */
export async function resolveImportTagIds(
  db: DbOrTx,
  params: {
    accountId: string;
    userId: string;
    tagNames: string[];
    canCreateTags: boolean;
    defaultColor?: string;
  }
): Promise<ResolveImportTagsResult> {
  const { accountId, userId, tagNames, canCreateTags } = params;
  const defaultColor = params.defaultColor ?? DEFAULT_TAG_COLOR;

  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  if (uniqueNames.length === 0) {
    return { tagIdByKey: new Map(), skippedNames: [] };
  }

  const existing = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.accountId, accountId));

  const tagIdByKey = new Map<string, string>();
  for (const tag of existing) {
    const key = tag.name.trim().toLowerCase();
    if (!tagIdByKey.has(key)) tagIdByKey.set(key, tag.id);
  }

  const skippedNames: string[] = [];
  const toCreate: string[] = [];

  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (tagIdByKey.has(key)) continue;
    if (canCreateTags) toCreate.push(name);
    else skippedNames.push(name);
  }

  if (toCreate.length > 0) {
    const created = await db
      .insert(tags)
      .values(toCreate.map((name) => ({ userId, accountId, name, color: defaultColor })))
      .returning({ id: tags.id, name: tags.name });

    for (const tag of created) {
      tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
    }
  }

  return { tagIdByKey, skippedNames };
}
