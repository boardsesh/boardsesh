'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type ConnectionState, connectionManager } from '@/app/lib/realtime/websocket-connection-manager';

type ConnectionContextValue = {
  state: ConnectionState;
  lastActivity: number | null;
  name: string | null;
  error?: Error | null;
  forceReconnect: () => void;
};

const WebSocketConnectionContext = createContext<ConnectionContextValue | null>(null);

export const WebSocketConnectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [snapshot, setSnapshot] = useState(connectionManager.getSnapshot());

  useEffect(() => {
    return connectionManager.subscribe((next) => setSnapshot(next));
  }, []);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      state: snapshot.state,
      lastActivity: snapshot.lastActivity,
      name: snapshot.name,
      error: snapshot.error,
      forceReconnect: () => connectionManager.forceReconnect(snapshot.name ?? undefined),
    }),
    [snapshot],
  );

  return <WebSocketConnectionContext.Provider value={value}>{children}</WebSocketConnectionContext.Provider>;
};

const IDLE_FALLBACK: ConnectionContextValue = {
  state: 'idle',
  lastActivity: null,
  name: null,
  error: null,
  forceReconnect: () => {},
};

export function useWebSocketConnection(): ConnectionContextValue {
  const ctx = useContext(WebSocketConnectionContext);
  const fallbackRef = useRef(IDLE_FALLBACK);

  if (!ctx) {
    // Fallback for usage outside the provider (e.g. SSR or unmounted trees).
    // Reads a point-in-time snapshot but does NOT subscribe — state changes
    // won't trigger re-renders. This is intentional: without a provider the
    // component tree has no subscription lifecycle. Consumers that need live
    // updates must be wrapped in <WebSocketConnectionProvider>.
    const snapshot = connectionManager.getSnapshot();
    const prev = fallbackRef.current;
    if (
      prev.state !== snapshot.state ||
      prev.lastActivity !== snapshot.lastActivity ||
      prev.name !== snapshot.name ||
      prev.error !== snapshot.error
    ) {
      fallbackRef.current = {
        state: snapshot.state,
        lastActivity: snapshot.lastActivity,
        name: snapshot.name,
        error: snapshot.error,
        forceReconnect: () => connectionManager.forceReconnect(snapshot.name ?? undefined),
      };
    }
    return fallbackRef.current;
  }
  return ctx;
}
