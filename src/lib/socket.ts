// src/lib/socket.ts
//
// Server-side realtime fan-out. server.js authenticates each socket
// and joins it to `account:<accountId>`; every emit here targets one
// account's room, so events never cross tenants.

import type { Server as IOServer } from "socket.io";

import type { conversations, messages } from "@/db/schema";
import { toSnake } from "@/db/serialize";

// Set once by server.js when the HTTP server boots. Undefined under
// `next build`, in tests, and in any process not started via server.js
// — emits are then silently skipped.
declare global {
  var __chatdesk_io: IOServer | undefined;
}

export interface RealtimeEventPayload {
  eventType: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  new: unknown;
  old?: unknown;
}

function emitToAccount(accountId: string, event: string, payload: RealtimeEventPayload) {
  global.__chatdesk_io?.to(`account:${accountId}`).emit(event, payload);
}

/** After a messages insert/update. Rows are snake_case, as the client expects. */
export function emitMessageEvent(accountId: string, event: RealtimeEventPayload) {
  emitToAccount(accountId, "message-event", event);
}

/** After a conversations insert/update. */
export function emitConversationEvent(accountId: string, event: RealtimeEventPayload) {
  emitToAccount(accountId, "conversation-event", event);
}

/** After a member_presence upsert. */
export function emitPresenceEvent(accountId: string, event: RealtimeEventPayload) {
  emitToAccount(accountId, "presence-event", event);
}

/**
 * After a message_reactions insert/update/delete. INSERT and UPDATE
 * both carry the full row on `new` — the client reducer upserts by id.
 * DELETE carries just `{ id }` on `old`.
 */
export function emitReactionEvent(accountId: string, event: RealtimeEventPayload) {
  emitToAccount(accountId, "reaction-event", event);
}

// ------------------------------------------------------------
// Row-level conveniences: take a Drizzle row, emit it in the
// snake_case shape the inbox reducers expect.
// ------------------------------------------------------------

type MessageRow = typeof messages.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

export function publishMessage(
  accountId: string,
  eventType: "INSERT" | "UPDATE",
  row: MessageRow,
) {
  emitMessageEvent(accountId, { eventType, new: toSnake(row) });
}

export function publishConversation(
  accountId: string,
  eventType: "INSERT" | "UPDATE",
  row: ConversationRow,
) {
  emitConversationEvent(accountId, { eventType, new: toSnake(row) });
}

/**
 * Tell one user their notifications changed (new one created, or read
 * elsewhere). server.js joins every socket to `user:<userId>`.
 */
export function emitNotificationEvent(userId: string) {
  global.__chatdesk_io?.to(`user:${userId}`).emit("notification-event", {});
}
