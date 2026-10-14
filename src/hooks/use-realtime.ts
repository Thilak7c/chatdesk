// src/hooks/use-realtime.ts

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Message, Conversation, MessageReaction } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  onReactionEvent?: (event: RealtimeEvent<MessageReaction>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  onReactionEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  const onReactionRef = useRef(onReactionEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
    onReactionRef.current = onReactionEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const socket = io({ path: "/api/socket" });
    socketRef.current = socket;

    socket.on("connect", () => setIsConnected(true));
    socket.on("disconnect", () => setIsConnected(false));

    socket.on("message-event", (event: RealtimeEvent<Message>) => {
      onMessageRef.current?.(event);
    });

    socket.on("conversation-event", (event: RealtimeEvent<Conversation>) => {
      onConversationRef.current?.(event);
    });

    socket.on("reaction-event", (event: RealtimeEvent<MessageReaction>) => {
      onReactionRef.current?.(event);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
    };
    // channelName is kept for call-site compatibility. The server puts
    // each socket in its own account's room, so only this account's
    // events arrive here.
  }, [enabled, channelName]);

  const unsubscribe = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setIsConnected(false);
  }, []);

  return { isConnected, unsubscribe };
}