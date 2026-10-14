// src/hooks/use-presence.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { useAuth } from "@/hooks/use-auth";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

// How often the viewer re-derives presence locally. The online→offline
// transition fires NO event (it's just the clock passing the staleness
// threshold), so without this tick a member who closes their tab would
// appear online forever. ~15s keeps "offline" responsive without
// busy-spinning.
const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old?: T;
}

interface PresencePayload {
  user_id: string;
  status: StoredPresence;
  last_seen_at: string;
}

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots (both advance on the same ~15s re-derive tick).
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account. Fetches an
 * initial snapshot from GET /api/presence, then listens for
 * "presence-event" over the shared Socket.io connection, and
 * re-derives "offline" on a local timer.
 *
 * Account comes from useAuth; pass `enabled: false` to opt a consumer
 * out (e.g. while a parent sheet is closed).
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();

  const [rows, setRows] = useState<PresenceMap>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    let cancelled = false;

    const applyRow = (row: PresencePayload) => {
      setRows((prev) => {
        const next = new Map(prev);
        next.set(row.user_id, {
          status: row.status,
          last_seen_at: row.last_seen_at,
        });
        return next;
      });
    };

    const socket: Socket = io({ path: "/api/socket" });

    socket.on("presence-event", (event: RealtimeEvent<PresencePayload>) => {
      if (event.eventType === "DELETE") {
        const old = event.old;
        if (!old?.user_id) return;
        setRows((prev) => {
          if (!prev.has(old.user_id)) return prev;
          const next = new Map(prev);
          next.delete(old.user_id);
          return next;
        });
        return;
      }
      applyRow(event.new);
    });

    // Fetch snapshot AFTER subscribing, and MERGE rather than replace,
    // so an event that lands while the fetch is in flight isn't
    // clobbered by a staler snapshot row.
    fetch("/api/presence")
      .then((res) => res.json())
      .then((data: PresencePayload[]) => {
        if (cancelled) return;
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of data ?? []) {
            const incoming: PresenceRow = {
              status: r.status,
              last_seen_at: r.last_seen_at,
            };
            const existing = next.get(r.user_id);
            if (
              !existing ||
              new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)
            ) {
              next.set(r.user_id, incoming);
            }
          }
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) console.error("[usePresence] initial fetch error:", err);
      });

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      socket.disconnect();
    };
  }, [active, accountId]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}