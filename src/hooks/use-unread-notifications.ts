// src/hooks/use-unread-notifications.ts

"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * Refreshes when the server pushes a notification-event to this user's
 * realtime room, with a slow poll as a safety net for a dropped socket.
 */
const FALLBACK_POLL_MS = 60_000;

export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/notifications/unread-count");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setCount(data.count ?? 0);
      } catch (err) {
        if (!cancelled) console.error("[useUnreadNotifications] fetch failed:", err);
      }
    };

    load();
    const interval = setInterval(load, FALLBACK_POLL_MS);
    const socket = io({ path: "/api/socket" });
    socket.on("notification-event", () => void load());
    socket.on("connect", () => void load());

    return () => {
      cancelled = true;
      clearInterval(interval);
      socket.disconnect();
    };
  }, []);

  return count;
}