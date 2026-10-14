// src/app/api/contacts/find-duplicate/route.ts

import { NextResponse } from "next/server";
import { and, eq, like } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { normalizePhone, phonesMatch } from "@/lib/whatsapp/phone-utils";

/**
 * GET /api/contacts/find-duplicate?phone=...
 *
 * Same approach as dedupe.ts's findExistingContact: pre-filter
 * in SQL by the last-8-digit suffix, then apply the strict phonesMatch
 * in JS on the small candidate set.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireRole("viewer");
    const url = new URL(req.url);
    const phone = url.searchParams.get("phone")?.trim() ?? "";

    const normalized = normalizePhone(phone);
    if (!normalized) {
      return NextResponse.json({ contact: null, exact: false });
    }

    const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

    const candidates = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.accountId, ctx.accountId), like(contacts.phone, `%${suffix}`)));

    const match = candidates.find((c) => phonesMatch(c.phone, phone));
    if (!match) {
      return NextResponse.json({ contact: null, exact: false });
    }

    const exact = normalizePhone(match.phone) === normalized;

    return NextResponse.json({
      contact: {
        id: match.id,
        phone: match.phone,
        name: match.name,
      },
      exact,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}