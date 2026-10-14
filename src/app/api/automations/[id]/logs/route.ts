// src/app/api/automations/[id]/logs/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { automations, automationLogs, contacts } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [automation] = await db
      .select({ id: automations.id })
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)));
    if (!automation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rows = await db
      .select({ log: automationLogs, contact: contacts })
      .from(automationLogs)
      .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
      .where(eq(automationLogs.automationId, id))
      .orderBy(desc(automationLogs.createdAt))
      .limit(100);

    const logs = rows.map(({ log, contact }) => ({
      id: log.id,
      automation_id: log.automationId,
      contact: contact ? { id: contact.id, name: contact.name, phone: contact.phone } : null,
      trigger_event: log.triggerEvent,
      steps_executed: log.stepsExecuted,
      status: log.status,
      error_message: log.errorMessage,
      created_at: log.createdAt,
    }));

    return NextResponse.json({ logs });
  } catch (err) {
    return toErrorResponse(err);
  }
}