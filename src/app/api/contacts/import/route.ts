// src/app/api/contacts/import/route.ts

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, contactTags, tags } from "@/db/schema";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { dedupeByPhone, normalizeKey } from "@/lib/contacts/dedupe";

const CHUNK_SIZE = 500;
const MAX_ROWS = 10000;
const DEFAULT_TAG_COLOR = "#3b82f6";

interface ImportRow {
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  tagNames: string[];
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseRows(input: unknown): ImportRow[] {
  if (!Array.isArray(input)) return [];
  const rows: ImportRow[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const phone = clean(raw.phone);
    if (!phone) continue;
    const tagNames = Array.isArray(raw.tagNames)
      ? raw.tagNames.map(clean).filter((n): n is string => n !== null)
      : [];
    rows.push({
      phone,
      name: clean(raw.name),
      email: clean(raw.email),
      company: clean(raw.company),
      tagNames,
    });
  }
  return rows;
}

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    parts.push(items.slice(i, i + size));
  }
  return parts;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole("agent");

    let body: { rows?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const rows = parseRows(body.rows);
    if (rows.length === 0) {
      return NextResponse.json({ error: "No valid rows" }, { status: 400 });
    }
    if (rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows (max ${MAX_ROWS})` },
        { status: 400 }
      );
    }

    const { unique, duplicates } = dedupeByPhone(rows);
    let skipped = duplicates;

    const existingRows = await db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId));
    const existing = new Set(existingRows.map((r) => normalizeKey(r.phone)));

    const toInsert = unique.filter((row) => {
      if (existing.has(normalizeKey(row.phone))) {
        skipped++;
        return false;
      }
      return true;
    });

    let imported = 0;
    const withTags: { id: string; tagNames: string[] }[] = [];

    for (const part of chunk(toInsert, CHUNK_SIZE)) {
      const created = await db
        .insert(contacts)
        .values(
          part.map((row) => ({
            userId: ctx.userId,
            accountId: ctx.accountId,
            phone: row.phone,
            name: row.name,
            email: row.email,
            company: row.company,
          }))
        )
        .onConflictDoNothing()
        .returning({ id: contacts.id, phone: contacts.phone });

      imported += created.length;
      skipped += part.length - created.length;

      const tagNamesByKey = new Map(
        part.map((row) => [normalizeKey(row.phone), row.tagNames])
      );
      for (const c of created) {
        const names = tagNamesByKey.get(normalizeKey(c.phone)) ?? [];
        if (names.length > 0) withTags.push({ id: c.id, tagNames: names });
      }
    }

    let tagsAssigned = 0;
    const skippedTagNames: string[] = [];

    if (withTags.length > 0) {
      try {
        const wanted = new Map<string, string>();
        for (const item of withTags) {
          for (const name of item.tagNames) {
            const key = name.toLowerCase();
            if (!wanted.has(key)) wanted.set(key, name);
          }
        }

        const existingTags = await db
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(eq(tags.accountId, ctx.accountId));

        const tagIdByKey = new Map<string, string>();
        for (const t of existingTags) {
          const key = t.name.trim().toLowerCase();
          if (!tagIdByKey.has(key)) tagIdByKey.set(key, t.id);
        }

        const missing = [...wanted.entries()].filter(
          ([key]) => !tagIdByKey.has(key)
        );
        const canCreateTags = ctx.role === "owner" || ctx.role === "admin";

        if (canCreateTags) {
          if (missing.length > 0) {
            const createdTags = await db
              .insert(tags)
              .values(
                missing.map(([, name]) => ({
                  userId: ctx.userId,
                  accountId: ctx.accountId,
                  name,
                  color: DEFAULT_TAG_COLOR,
                }))
              )
              .returning({ id: tags.id, name: tags.name });
            for (const t of createdTags) {
              tagIdByKey.set(t.name.trim().toLowerCase(), t.id);
            }
          }
        } else {
          for (const [, name] of missing) skippedTagNames.push(name);
        }

        const links: { contactId: string; tagId: string }[] = [];
        for (const item of withTags) {
          for (const name of item.tagNames) {
            const tagId = tagIdByKey.get(name.toLowerCase());
            if (tagId) links.push({ contactId: item.id, tagId });
          }
        }

        for (const part of chunk(links, CHUNK_SIZE)) {
          const res = await db
            .insert(contactTags)
            .values(part)
            .onConflictDoNothing()
            .returning({ id: contactTags.id });
          tagsAssigned += res.length;
        }
      } catch (err) {
        console.error("POST /api/contacts/import tag step failed:", err);
      }
    }

    return NextResponse.json({
      imported,
      skipped,
      tagsAssigned,
      skippedTagNames,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}