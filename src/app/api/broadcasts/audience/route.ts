// src/app/api/broadcasts/audience/route.ts

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { contacts, contactTags, contactCustomValues } from "@/db/schema";
import { and, eq, ne, ilike, inArray } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { normalizeKey } from "@/lib/contacts/dedupe";

function toApiContact(c: typeof contacts.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    company: c.company,
    avatar_url: c.avatarUrl,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

async function fetchCustomValues(contactIds: string[]) {
  const result: Record<string, Record<string, string>> = {};
  if (contactIds.length === 0) return result;

  const rows = await db
    .select()
    .from(contactCustomValues)
    .where(inArray(contactCustomValues.contactId, contactIds));

  for (const row of rows) {
    const bucket = result[row.contactId] ?? {};
    bucket[row.customFieldId] = row.value ?? "";
    result[row.contactId] = bucket;
  }
  return result;
}

async function applyExclude(
  accountId: string,
  contactList: (typeof contacts.$inferSelect)[],
  excludeTagIds?: string[],
) {
  if (!excludeTagIds || excludeTagIds.length === 0) return contactList;
  const excludeRows = await db
    .select({ contactId: contactTags.contactId })
    .from(contactTags)
    .where(inArray(contactTags.tagId, excludeTagIds));
  const excluded = new Set(excludeRows.map((r) => r.contactId));
  return contactList.filter((c) => !excluded.has(c.id));
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireRole("agent");
    const body = await request.json();
    const {
      type,
      tagIds,
      customField,
      csvContacts,
      excludeTagIds,
    }: {
      type: "all" | "tags" | "custom_field" | "csv";
      tagIds?: string[];
      customField?: { fieldId: string; operator: "is" | "is_not" | "contains"; value: string };
      csvContacts?: { phone: string; name?: string }[];
      excludeTagIds?: string[];
    } = body;

    let contactList: (typeof contacts.$inferSelect)[] = [];

    if (type === "all") {
      contactList = await db
        .select()
        .from(contacts)
        .where(eq(contacts.accountId, ctx.accountId));
    } else if (type === "tags" && tagIds && tagIds.length > 0) {
      const rows = await db
        .select({ contactId: contactTags.contactId })
        .from(contactTags)
        .where(inArray(contactTags.tagId, tagIds));
      const ids = [...new Set(rows.map((r) => r.contactId))];
      if (ids.length > 0) {
        contactList = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.accountId, ctx.accountId), inArray(contacts.id, ids)));
      }
    } else if (type === "custom_field" && customField) {
      const { fieldId, operator, value } = customField;
      let valueCondition;
      if (operator === "is") valueCondition = eq(contactCustomValues.value, value);
      else if (operator === "is_not") valueCondition = ne(contactCustomValues.value, value);
      else valueCondition = ilike(contactCustomValues.value, `%${value}%`);

      const rows = await db
        .select({ contactId: contactCustomValues.contactId })
        .from(contactCustomValues)
        .where(and(eq(contactCustomValues.customFieldId, fieldId), valueCondition));
      const ids = [...new Set(rows.map((r) => r.contactId))];
      if (ids.length > 0) {
        contactList = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.accountId, ctx.accountId), inArray(contacts.id, ids)));
      }
    } else if (type === "csv" && csvContacts) {
      const uniqueByKey = new Map<string, { phone: string; name?: string }>();
      for (const row of csvContacts) {
        const key = normalizeKey(row.phone);
        if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
      }
      const keys = [...uniqueByKey.keys()];

      const existing = await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            inArray(contacts.phoneNormalized, keys),
          ),
        );

      const byKey = new Map<string, typeof contacts.$inferSelect>();
      for (const c of existing) {
        const key = normalizeKey(c.phone ?? "");
        if (key) byKey.set(key, c);
      }

      const missing = keys
        .filter((k) => !byKey.has(k))
        .map((k) => uniqueByKey.get(k)!)
        .map((row) => ({
          userId: ctx.userId,
          accountId: ctx.accountId,
          phone: row.phone,
          name: row.name ?? null,
        }));

      if (missing.length > 0) {
        const inserted = await db.insert(contacts).values(missing).returning();
        for (const c of inserted) {
          const key = normalizeKey(c.phone ?? "");
          if (key) byKey.set(key, c);
        }
      }

      contactList = keys
        .map((k) => byKey.get(k))
        .filter((c): c is typeof contacts.$inferSelect => Boolean(c));
    }

    contactList = await applyExclude(ctx.accountId, contactList, excludeTagIds);

    const customValues = await fetchCustomValues(contactList.map((c) => c.id));

    return NextResponse.json({
      contacts: contactList.map(toApiContact),
      custom_values: customValues,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}