import { and, eq, gte, lt, desc, count } from "drizzle-orm";

import { db } from "@/db";
import {
  conversations,
  contacts,
  deals,
  messages,
  pipelines,
  pipelineStages,
  broadcasts,
  automationLogs,
  automations,
} from "@/db/schema";
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from "./date-utils";
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from "./types";

// ------------------------------------------------------------
// Server-only. Every query is explicitly scoped by `accountId` —
// there is no RLS anymore, so the caller (an API route that already
// resolved the account via requireRole/getCurrentAccount) must pass
// the right id in. Never call these from client components.
// ------------------------------------------------------------

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(accountId: string): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay();
  const yesterdayStart = daysAgoStart(1);

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDealsRows,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db
      .select({ c: count() })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.status, "open"))),
    db
      .select({ c: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.status, "open"),
          gte(conversations.createdAt, todayStart),
        ),
      ),
    db
      .select({ c: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.status, "open"),
          gte(conversations.createdAt, yesterdayStart),
          lt(conversations.createdAt, todayStart),
        ),
      ),
    db
      .select({ c: count() })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), gte(contacts.createdAt, todayStart))),
    db
      .select({ c: count() })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          gte(contacts.createdAt, yesterdayStart),
          lt(contacts.createdAt, todayStart),
        ),
      ),
    db
      .select({ value: deals.value })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, "open"))),
    db
      .select({ c: count() })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(messages.senderType, "agent"),
          gte(messages.createdAt, todayStart),
        ),
      ),
    db
      .select({ c: count() })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(messages.senderType, "agent"),
          gte(messages.createdAt, yesterdayStart),
          lt(messages.createdAt, todayStart),
        ),
      ),
  ]);

  const openDealsValue = openDealsRows.reduce((sum, d) => sum + Number(d.value ?? 0), 0);

  return {
    activeConversations: {
      current: openConvCur[0]?.c ?? 0,
      previous: (newConvToday[0]?.c ?? 0) - (newConvYesterday[0]?.c ?? 0),
    },
    newContactsToday: {
      current: newContactsToday[0]?.c ?? 0,
      previous: newContactsYesterday[0]?.c ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday[0]?.c ?? 0,
      previous: messagesYesterday[0]?.c ?? 0,
    },
  };
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  accountId: string,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1);

  const rows = await db
    .select({ createdAt: messages.createdAt, senderType: messages.senderType })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.accountId, accountId), gte(messages.createdAt, start)))
    .orderBy(messages.createdAt);

  const keys = lastNDayKeys(rangeDays);
  const buckets = new Map<string, { incoming: number; outgoing: number }>();
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 });

  for (const row of rows) {
    const key = localDayKey(row.createdAt!.toISOString());
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (row.senderType === "customer") bucket.incoming += 1;
    else bucket.outgoing += 1;
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }));
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(accountId: string): Promise<PipelineDonutData> {
  const [stageRows, dealRows] = await Promise.all([
    db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        color: pipelineStages.color,
      })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
      .where(eq(pipelines.accountId, accountId))
      .orderBy(pipelineStages.position),
    db
      .select({ stageId: deals.stageId, value: deals.value })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, "open"))),
  ]);

  const byStage = new Map<string, { count: number; total: number }>();
  for (const d of dealRows) {
    const row = byStage.get(d.stageId) ?? { count: 0, total: 0 };
    row.count += 1;
    row.total += Number(d.value ?? 0);
    byStage.set(d.stageId, row);
  }

  const slices: PipelineStageSlice[] = stageRows
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || "#64748b",
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    .filter((s) => s.totalValue > 0 || s.dealCount > 0);

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  };
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(accountId: string): Promise<ResponseTimeSummary> {
  const fourteenDaysAgo = daysAgoStart(13);

  const rows = await db
    .select({
      conversationId: messages.conversationId,
      senderType: messages.senderType,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.accountId, accountId), gte(messages.createdAt, fourteenDaysAgo)))
    .orderBy(messages.conversationId, messages.createdAt);

  interface Sample {
    customerAt: Date;
    responseAt: Date;
  }
  const samples: Sample[] = [];

  let currentConv = "";
  let pendingCustomer: Date | null = null;
  for (const row of rows) {
    if (row.conversationId !== currentConv) {
      currentConv = row.conversationId;
      pendingCustomer = null;
    }
    const ts = row.createdAt!;
    if (row.senderType === "customer") {
      if (!pendingCustomer) pendingCustomer = ts;
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts });
      pendingCustomer = null;
    }
  }

  const now = new Date();
  const thisWeekStart = daysAgoStart(mondayIndex(now));
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7);

  const byDow = new Map<number, number[]>();
  for (let i = 0; i < 7; i++) byDow.set(i, []);
  const thisWeekMins: number[] = [];
  const lastWeekMins: number[] = [];

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000;
    if (diffMin < 0) continue;
    const dow = mondayIndex(s.customerAt);
    byDow.get(dow)!.push(diffMin);
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin);
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin);
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const s = byDow.get(dow) ?? [];
    return { dow, avgMinutes: avg(s), samples: s.length };
  });

  void DOW_SHORT_MON_FIRST;

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  };
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(accountId: string, limit = 20): Promise<ActivityItem[]> {
  const [msgRows, contactRows, dealRows, broadcastRows, autoLogRows] = await Promise.all([
    db
      .select({
        id: messages.id,
        createdAt: messages.createdAt,
        conversationId: messages.conversationId,
        contactName: contacts.name,
        contactPhone: contacts.phone,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(and(eq(conversations.accountId, accountId), eq(messages.senderType, "customer")))
      .orderBy(desc(messages.createdAt))
      .limit(10),
    db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, createdAt: contacts.createdAt })
      .from(contacts)
      .where(eq(contacts.accountId, accountId))
      .orderBy(desc(contacts.createdAt))
      .limit(10),
    db
      .select({
        id: deals.id,
        title: deals.title,
        updatedAt: deals.updatedAt,
        stageName: pipelineStages.name,
      })
      .from(deals)
      .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .where(eq(deals.accountId, accountId))
      .orderBy(desc(deals.updatedAt))
      .limit(10),
    db
      .select({
        id: broadcasts.id,
        name: broadcasts.name,
        status: broadcasts.status,
        totalRecipients: broadcasts.totalRecipients,
        createdAt: broadcasts.createdAt,
      })
      .from(broadcasts)
      .where(eq(broadcasts.accountId, accountId))
      .orderBy(desc(broadcasts.createdAt))
      .limit(5),
    db
      .select({
        id: automationLogs.id,
        triggerEvent: automationLogs.triggerEvent,
        status: automationLogs.status,
        createdAt: automationLogs.createdAt,
        automationName: automations.name,
        contactName: contacts.name,
        contactPhone: contacts.phone,
      })
      .from(automationLogs)
      .innerJoin(automations, eq(automationLogs.automationId, automations.id))
      .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
      .where(eq(automations.accountId, accountId))
      .orderBy(desc(automationLogs.createdAt))
      .limit(10),
  ]);

  const items: ActivityItem[] = [];

  for (const m of msgRows) {
    const who = m.contactName || m.contactPhone || "Unknown";
    items.push({
      id: `msg-${m.id}`,
      kind: "message",
      text: `New message from ${who}`,
      at: m.createdAt!.toISOString(),
      href: `/inbox?c=${m.conversationId}`,
    });
  }

  for (const c of contactRows) {
    items.push({
      id: `contact-${c.id}`,
      kind: "contact",
      text: `New contact: ${c.name || c.phone}`,
      at: c.createdAt!.toISOString(),
      href: "/contacts",
    });
  }

  for (const d of dealRows) {
    items.push({
      id: `deal-${d.id}`,
      kind: "deal",
      text: d.stageName ? `Deal "${d.title}" in ${d.stageName}` : `Deal "${d.title}" updated`,
      at: d.updatedAt!.toISOString(),
      href: "/pipelines",
    });
  }

  for (const b of broadcastRows) {
    const label =
      b.status === "sent"
        ? `sent to ${b.totalRecipients} contacts`
        : `${b.status} (${b.totalRecipients} recipients)`;
    items.push({
      id: `broadcast-${b.id}`,
      kind: "broadcast",
      text: `Broadcast "${b.name}" ${label}`,
      at: b.createdAt!.toISOString(),
      href: "/broadcasts",
    });
  }

  for (const l of autoLogRows) {
    const who = l.contactName || l.contactPhone || "a contact";
    const autoName = l.automationName || "Automation";
    items.push({
      id: `auto-${l.id}`,
      kind: "automation",
      text: `Automation "${autoName}" ${l.status === "failed" ? "failed for" : "triggered for"} ${who}`,
      at: l.createdAt!.toISOString(),
    });
  }

  return items.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0)).slice(0, limit);
}