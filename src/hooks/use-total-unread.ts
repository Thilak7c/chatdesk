// src/hooks/use-total-unread.ts

"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user's account. Used by the sidebar to surface a dot on
 * the Inbox nav entry.
 *
 * Refreshes whenever the server announces a conversation change on the
 * account's realtime room (new inbound, read, assignment, ...), with a
 * slow poll as a safety net for a dropped socket.
 */
const FALLBACK_POLL_MS = 60_000;

export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const res = await fetch("/api/conversations/unread-count");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setTotal(data.total ?? 0);
      } catch (err) {
        if (!cancelled) console.error("[useTotalUnread] fetch failed:", err);
      }
    };

    // Coalesce bursts (a broadcast reply storm) into one refetch.
    const scheduleLoad = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void load();
      }, 500);
    };

    load();
    const interval = setInterval(load, FALLBACK_POLL_MS);
    const socket = io({ path: "/api/socket" });
    socket.on("conversation-event", scheduleLoad);
    socket.on("connect", scheduleLoad);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (pending) clearTimeout(pending);
      socket.disconnect();
    };
  }, []);

  return total;
}
