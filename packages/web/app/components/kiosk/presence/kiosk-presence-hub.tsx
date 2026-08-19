'use client';

// KioskPresenceHub — the kiosk's single live-data spine.
//
// One graphql-ws client for the whole TV (connectionName 'kiosk'), shared by
// one BoardPresenceProvider per DISTINCT board. Each provider runs the shared
// subscribe→backfill state machine (`useBoardPresence`) for its board; a
// capture component inside each provider publishes the resulting snapshot into
// a Map context that widgets (board slots, session leaderboard) read from —
// see use-kiosk-board-presence.ts.
//
// The default export is the LOGIN-LESS hub the display routes (/kiosk/**,
// /embed/**) mount: it connects anonymously and never touches
// `/api/internal/ws-auth`, so a TV boots straight into its socket instead of
// waiting on a session check it has no use for. Every read it makes is already
// anon-tolerant server-side (`requireAnonReadableBoard`), and its presence
// client is structurally read-only. The gym-manage live preview is the one
// consumer that DOES need a viewer — it renders private gym boards — and
// mounts `ViewerKioskPresenceHub` from ./viewer-kiosk-presence-hub instead.
//
// Reconnect/backoff lives inside the shared createGraphQLClient (exponential
// retryWait, 10 attempts) — NOT duplicated here. What IS here is the layer
// above it: graphql-ws's retry budget is finite and its counter only resets on
// a successful connect, so once the budget is spent the client is dead for
// good and `useBoardPresence` never re-subscribes. On a desk that's a reload;
// on an unattended wall it's a frozen screen until the 04:00 reload. So the hub
// supervises: a socket that stays down past PRESENCE_REBUILD_AFTER_MS gets the
// whole client rebuilt from scratch. Longer/other outages are still covered by
// kiosk-reliability.tsx (periodic manual catch-up + daily reload).

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BoardPresenceProvider } from '@boardsesh/board-presence-react';
import { createGraphQLClient, type Client } from '@/app/lib/realtime/graphql-client';
import {
  createReadOnlyWebBoardPresenceClient,
  type WebBoardPresenceClient,
} from '@/app/lib/realtime/board-presence-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { KioskBoardFeedBridge } from '../kiosk-reliability';
import {
  createKioskPresenceStore,
  KioskConnectionStatusContext,
  KioskPresenceStoreContext,
  type KioskBoardSnapshot,
  type KioskConnectionStatus,
} from './use-kiosk-board-presence';

/**
 * How long the socket may stay down before the hub throws the client away and
 * builds a new one. One notch above graphql-ws's own full retry budget (10
 * attempts of capped-exponential backoff, ~90-180s) so an ordinary blip is
 * healed by the library and never reaches this path.
 */
export const PRESENCE_REBUILD_AFTER_MS = 5 * 60_000;

export type KioskPresenceHubProps = { boardIds: number[]; children: ReactNode };

export type KioskPresenceHubInnerProps = KioskPresenceHubProps & {
  /** Token for the ws connection. `null` connects anonymously. */
  authToken: string | null;
  /**
   * True while an auth lookup is still in flight. The client build is held
   * until it settles so a viewer hub does not build an anonymous client and
   * immediately dispose it for an authenticated one. The anonymous hub passes
   * `false` — it has nothing to wait for.
   */
  isAuthResolving: boolean;
  /**
   * How to wrap the ws client: read-only for displays, full for a viewer.
   * MUST be a stable reference (both callers pass a module-level function) —
   * it is a dep of the `presenceClient` memo, so an inline arrow here would
   * rebuild the presence client on every render.
   */
  createPresenceClient: (getClient: () => Client) => WebBoardPresenceClient;
};

export function KioskPresenceHubInner({
  boardIds,
  authToken,
  isAuthResolving,
  createPresenceClient,
  children,
}: KioskPresenceHubInnerProps) {
  const hasBoards = boardIds.length > 0;

  const [activeWsClient, setActiveWsClient] = useState<Client | null>(null);
  const clientRef = useRef<Client | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<KioskConnectionStatus>('connecting');
  // The presence store lives outside React's render tree so a single board's
  // event notifies only its own subscribers — one wall going live doesn't
  // re-render every other board's art. Created once for the hub's lifetime.
  const [store] = useState(createKioskPresenceStore);
  // Bumped when the supervisor gives up on a client. It is an effect dep, so a
  // bump tears the old client down and builds a fresh one — with graphql-ws's
  // retry counter back at zero and every BoardPresenceProvider re-subscribing
  // and re-backfilling underneath it.
  const [clientGeneration, setClientGeneration] = useState(0);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasBoards) return;
    if (isAuthResolving) return;
    const wsUrl = getBackendWsUrl();
    if (!wsUrl) return;

    const clearRebuildTimer = () => {
      if (rebuildTimerRef.current === null) return;
      clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = null;
    };

    const client = createGraphQLClient({ url: wsUrl, authToken, connectionName: 'kiosk' });
    // Drive the header's reconnect chip off the socket lifecycle. graphql-ws
    // retries with backoff internally; we only surface the state.
    const offConnected = client.on('connected', () => {
      clearRebuildTimer();
      setConnectionStatus('connected');
    });
    const offClosed = client.on('closed', () => {
      setConnectionStatus('reconnecting');
      // graphql-ws emits `closed` once per failed retry, so keep the FIRST
      // countdown running: the window measures time since the wall went dark,
      // not time since the latest attempt.
      if (rebuildTimerRef.current !== null) return;
      rebuildTimerRef.current = setTimeout(() => {
        rebuildTimerRef.current = null;
        setClientGeneration((generation) => generation + 1);
      }, PRESENCE_REBUILD_AFTER_MS);
    });

    clientRef.current = client;
    setActiveWsClient(client);

    return () => {
      clearRebuildTimer();
      offConnected();
      offClosed();
      void client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      setActiveWsClient((currentClient) => (currentClient === client ? null : currentClient));
    };
    // Deps are primitives on purpose — `boardIds` is a fresh array identity on
    // every render, so listing it here would rebuild the socket per render.
  }, [authToken, hasBoards, isAuthResolving, clientGeneration]);

  const presenceClient = useMemo<WebBoardPresenceClient | null>(() => {
    if (activeWsClient === null) return null;
    return createPresenceClient(() => {
      const client = clientRef.current;
      if (!client) {
        throw new Error('Kiosk presence WS client is not connected yet');
      }
      return client;
    });
  }, [activeWsClient, createPresenceClient]);

  const publishSnapshot = useCallback(
    (boardId: number, snapshot: KioskBoardSnapshot) => {
      store.publish(boardId, snapshot);
    },
    [store],
  );

  return (
    <KioskConnectionStatusContext.Provider value={connectionStatus}>
      <KioskPresenceStoreContext.Provider value={store}>
        {boardIds.map((boardId) => (
          <BoardPresenceProvider
            key={boardId}
            boardId={presenceClient === null ? null : boardId}
            client={presenceClient}
          >
            <KioskBoardFeedBridge boardId={boardId} onSnapshot={publishSnapshot} />
          </BoardPresenceProvider>
        ))}
        {children}
      </KioskPresenceStoreContext.Provider>
    </KioskConnectionStatusContext.Provider>
  );
}

/**
 * The login-less hub the public display routes mount. No session, no
 * `/api/internal/ws-auth` round trip, and a read-only presence client.
 */
export default function KioskPresenceHub({ boardIds, children }: KioskPresenceHubProps) {
  return (
    <KioskPresenceHubInner
      boardIds={boardIds}
      authToken={null}
      isAuthResolving={false}
      createPresenceClient={createReadOnlyWebBoardPresenceClient}
    >
      {children}
    </KioskPresenceHubInner>
  );
}
