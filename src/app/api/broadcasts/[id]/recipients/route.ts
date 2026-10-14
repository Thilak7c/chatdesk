// src/app/api/broadcasts/[id]/recipients/route.ts
//
// GET  — the broadcast's recipients, newest first, each with its contact.
// POST — add recipient rows (status 'pending') for contacts in this
//        account. Used by the broadcast wizard right after it creates
//        the broadcast row.

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { broadcastRecipients, broadcasts, contacts } from "@/db/schema";
import { toSnake } from "@/db/serialize";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS_PER_REQUEST = 10_000;

async function findBroadcast(accountId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;
    if (!(await findBroadcast(ctx.accountId, id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select({ recipient: broadcastRecipients, contact: contacts })
      .from(broadcastRecipients)
      .leftJoin(contacts, eq(contacts.id, broadcastRecipients.contactId))
      .where(eq(broadcastRecipients.broadcastId, id))
      .orderBy(desc(broadcastRecipients.createdAt));

    return NextResponse.json({
      recipients: rows.map(({ recipient, contact }) => ({
        ...toSnake(recipient),
        contact: contact ? toSnake(contact) : null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    if (!(await findBroadcast(ctx.accountId, id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      recipients?: { contact_id?: unknown; template_params?: unknown }[];
    } | null;
    const input = Array.isArray(body?.recipients) ? body.recipients : [];
    if (input.length === 0 || input.length > MAX_RECIPIENTS_PER_REQUEST) {
      return NextResponse.json(
        { error: `'recipients' must be a non-empty array (max ${MAX_RECIPIENTS_PER_REQUEST})` },
        { status: 400 },
      );
    }

    const contactIds = [
      ...new Set(
        input
          .map((r) => r.contact_id)
          .filter((v): v is string => typeof v === "string" && UUID_RE.test(v)),
      ),
    ];
    // Only contacts that belong to this account can be recipients.
    const owned = new Set<string>();
    for (let i = 0; i < contactIds.length; i += 1000) {
      const rows = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            inArray(contacts.id, contactIds.slice(i, i + 1000)),
          ),
        );
      for (const r of rows) owned.add(r.id);
    }

    const seen = new Set<string>();
    const values = input.flatMap((r) => {
      const contactId = typeof r.contact_id === "string" ? r.contact_id : "";
      if (!owned.has(contactId) || seen.has(contactId)) return [];
      seen.add(contactId);
      const params = Array.isArray(r.template_params)
        ? r.template_params.filter((p): p is string => typeof p === "string")
        : [];
      return [{ broadcastId: id, contactId, status: "pending", templateParams: params }];
    });
    if (values.length === 0) {
      return NextResponse.json({ error: "No valid recipients" }, { status: 400 });
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < values.length; i += 1000) {
        await tx.insert(broadcastRecipients).values(values.slice(i, i + 1000));
      }
      await tx
        .update(broadcasts)
        .set({ totalRecipients: values.length })
        .where(eq(broadcasts.id, id));
    });

    return NextResponse.json({ inserted: values.length }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
