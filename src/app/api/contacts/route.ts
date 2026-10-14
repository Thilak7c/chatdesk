// src/app/api/contacts/route.ts

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { contacts, contactTags, tags } from "@/db/schema";
import { getCurrentAccount } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function auth() {
  try {
    return await getCurrentAccount();
  } catch {
    return null;
  }
}

function toContact(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    phone: row.phone,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const ctx = await auth();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const term = (sp.get("search") ?? "").trim();
  const tagIds = (sp.get("tagIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 25, 1), 100);
  const offset = Math.max(Number(sp.get("offset")) || 0, 0);

  const conditions = [eq(contacts.accountId, ctx.accountId)];

  if (term) {
    const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(contacts.name, like),
        ilike(contacts.phone, like),
        ilike(contacts.email, like)
      )!
    );
  }

  if (tagIds.length > 0) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(contactTags)
          .where(
            and(
              eq(contactTags.contactId, contacts.id),
              inArray(contactTags.tagId, tagIds)
            )
          )
      )
    );
  }

  const where = and(...conditions);

  try {
    const [rows, countRows] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(where),
    ]);

    const tagsByContact = new Map<
      string,
      { id: string; name: string; color: string }[]
    >();

    if (rows.length > 0) {
      const tagRows = await db
        .select({
          contactId: contactTags.contactId,
          id: tags.id,
          name: tags.name,
          color: tags.color,
        })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(
          and(
            inArray(
              contactTags.contactId,
              rows.map((r) => r.id)
            ),
            eq(tags.accountId, ctx.accountId)
          )
        );

      for (const t of tagRows) {
        const list = tagsByContact.get(t.contactId) ?? [];
        list.push({ id: t.id, name: t.name, color: t.color });
        tagsByContact.set(t.contactId, list);
      }
    }

    return NextResponse.json({
      contacts: rows.map((r) => ({
        ...toContact(r),
        tags: tagsByContact.get(r.id) ?? [],
      })),
      total: countRows[0]?.count ?? 0,
    });
  } catch (err) {
    console.error("GET /api/contacts failed:", err);
    return NextResponse.json({ error: "Failed to load contacts" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ctx = await auth();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ctx.role === "viewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const clean = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const phone = clean(body.phone);
  if (!phone) {
    return NextResponse.json({ error: "Phone is required" }, { status: 400 });
  }

  try {
    const [row] = await db
      .insert(contacts)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        phone,
        name: clean(body.name),
        email: clean(body.email),
        company: clean(body.company),
      })
      .returning();

    return NextResponse.json({ contact: toContact(row) }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: "A contact with this phone already exists" },
        { status: 409 }
      );
    }
    console.error("POST /api/contacts failed:", err);
    return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
  }
}