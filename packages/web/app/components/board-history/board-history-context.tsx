'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardHistoryEntry, BoardHistoryEvent } from '@boardsesh/shared-schema';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLClient, subscribe, type Client } from '@/app/components/graphql-queue/graphql-client';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { useBluetoothConnectedSerial } from '@/app/components/board-bluetooth-control/bluetooth-status-store';
import { useResolvedBoardSerialForRoute } from './use-resolved-board-serial-for-route';
import {
  BOARD_HISTORY_LATEST_QUERY,
  BOARD_HISTORY_EVENTS_SUBSCRIPTION,
  type BoardHistoryLatestResponse,
  type BoardHistoryEventsPayload,
} from './board-history-operations';
import type { BoardHistoryContextValue } from './types';

const BoardHistoryContext = createContext<BoardHistoryContextValue | null>(null);

/**
 * Provides the live "what was on the wall" log for the active board.
 *
 * Resolution order for the board serial:
 * 1. BLE-connected serial from `useBluetoothConnectedSerial()` — the source
 *    of truth when the user has a controller paired locally.
 * 2. Route fallback via `useResolvedBoardSerialForRoute()` — covers the
 *    "browsing a saved board on my phone while a roommate is on the wall"
 *    scenario.
 * 3. Null — no subscribe, empty state, no fetch.
 *
 * On serial change:
 * - Cancel any in-flight subscription
 * - Run the seed query (`BOARD_HISTORY_LATEST_QUERY`) to populate the
 *   `latestEntry` synchronously while the subscription is opening
 * - Open `BOARD_HISTORY_EVENTS_SUBSCRIPTION`. `BoardHistoryFullSync` replaces
 *   state; `BoardHistoryEntryAdded` prepends (deduped by id)
 *
 * The soft pairing gate on the server may reject the subscription for users
 * who have never paired the BLE controller. We treat that as a non-error —
 * the provider stays mounted with an empty history.
 */
export function BoardHistoryProvider({ children }: { children: React.ReactNode }) {
  const { token, isAuthenticated } = useWsAuthToken();
  const bleSerial = useBluetoothConnectedSerial();
  const routeSerial = useResolvedBoardSerialForRoute();
  const boardSerial = bleSerial ?? routeSerial ?? null;

  const [history, setHistory] = useState<BoardHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);

  // The active WS client + unsubscribe pair, scoped to the current serial.
  // Tracked in refs so the effect can tear them down cleanly on serial change.
  const clientRef = useRef<Client | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Reset state whenever the serial changes — stale entries from a previous
    // board are never carried over.
    setHistory([]);
    setIsSubscribed(false);

    if (!boardSerial || !isAuthenticated || !token) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    // Dispose any prior client+subscription before opening a new one.
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (clientRef.current) {
      void clientRef.current.dispose();
      clientRef.current = null;
    }

    // Seed via HTTP query — gives consumers a `latestEntry` immediately
    // without waiting for the WS handshake + FullSync round trip.
    const httpClient = createGraphQLHttpClient(token);
    httpClient
      .request<BoardHistoryLatestResponse>(BOARD_HISTORY_LATEST_QUERY, { boardSerial })
      .then((response) => {
        if (cancelled) return;
        setHistory(response.boardHistory ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        // Soft pairing rejection lands here too — fall through to subscribe;
        // if the gate also rejects the subscription we end up with the empty
        // initial state, which is the intended outcome.
        console.warn('[BoardHistory] seed query failed:', err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    // Open the WS subscription. We use a dedicated connection (separate from
    // the party-session WS) so a stale session subscription failure never
    // takes down board-history streaming.
    const wsUrl = getBackendWsUrl();
    if (!wsUrl) {
      // No backend URL configured (e.g. some test envs) — leave the provider
      // with the seeded state and skip the subscription.
      return () => {
        cancelled = true;
      };
    }

    const wsClient = createGraphQLClient({
      url: wsUrl,
      authToken: token,
      connectionName: 'board-history',
    });
    clientRef.current = wsClient;

    const unsubscribe = subscribe<BoardHistoryEventsPayload>(
      wsClient,
      { query: BOARD_HISTORY_EVENTS_SUBSCRIPTION, variables: { boardSerial } },
      {
        next: (data) => {
          if (cancelled) return;
          const event: BoardHistoryEvent = data.boardHistoryEvents;
          if (!event) return;
          if (event.__typename === 'BoardHistoryFullSync') {
            setHistory(event.entries);
            setIsSubscribed(true);
          } else if (event.__typename === 'BoardHistoryEntryAdded') {
            setHistory((prev) => {
              // Dedupe by id — guards against overlap between the initial
              // seed query and the FullSync that lands on subscribe.
              if (prev.some((entry) => entry.id === event.entry.id)) return prev;
              return [event.entry, ...prev];
            });
          }
        },
        error: (err) => {
          if (cancelled) return;
          // Soft pairing gate rejections, transient network errors, and
          // server-emitted GraphQL errors all land here. Empty history +
          // un-subscribed state is the intended fallback — do NOT throw.
          console.warn('[BoardHistory] subscription error:', err);
          setIsSubscribed(false);
        },
        complete: () => {
          if (cancelled) return;
          setIsSubscribed(false);
        },
      },
    );
    unsubscribeRef.current = unsubscribe;

    return () => {
      cancelled = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      if (clientRef.current === wsClient) {
        void wsClient.dispose();
        clientRef.current = null;
      } else {
        void wsClient.dispose();
      }
    };
  }, [boardSerial, isAuthenticated, token]);

  const latestEntry = history.length > 0 ? history[0] : null;

  const value = useMemo<BoardHistoryContextValue>(
    () => ({
      history,
      latestEntry,
      boardSerial,
      isLoading,
      isSubscribed,
    }),
    [history, latestEntry, boardSerial, isLoading, isSubscribed],
  );

  return <BoardHistoryContext.Provider value={value}>{children}</BoardHistoryContext.Provider>;
}

/**
 * Read the current board history. Throws when used outside of
 * `<BoardHistoryProvider>` — that's a programming error, not a runtime
 * condition (the provider sits at the root tree alongside the other
 * persistent providers).
 */
export function useBoardHistory(): BoardHistoryContextValue {
  const context = useContext(BoardHistoryContext);
  if (!context) {
    throw new Error('useBoardHistory must be used within a BoardHistoryProvider');
  }
  return context;
}
