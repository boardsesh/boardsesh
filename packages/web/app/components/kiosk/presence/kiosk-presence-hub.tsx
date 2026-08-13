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
// Wiring mirrors WebBoardPresenceProvider (board-presence-context.tsx): the
// client is rebuilt when the ws auth token loads (anonymous is fine — kiosk
// boards are public), and reconnect/backoff lives inside the shared
// createGraphQLClient (exponential retryWait, 10 attempts) — NOT duplicated
// here. Longer outages are covered by kiosk-reliability.tsx (periodic manual
// catch-up + daily reload).

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BoardPresenceProvider } from '@boardsesh/board-presence-react';
import { createGraphQLClient, type Client } from '@/app/lib/realtime/graphql-client';
import { createWebBoardPresenceClient, type WebBoardPresenceClient } from '@/app/lib/realtime/board-presence-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { KioskBoardFeedBridge } from '../kiosk-reliability';
import {
  createKioskPresenceStore,
  KioskConnectionStatusContext,
  KioskPresenceStoreContext,
  type KioskBoardSnapshot,
  type KioskConnectionStatus,
} from './use-kiosk-board-presence';

export default function KioskPresenceHub({ boardIds, children }: { boardIds: number[]; children: ReactNode }) {
  const { token, isLoading: isTokenLoading } = useWsAuthToken();
  const hasBoards = boardIds.length > 0;

  const [activeWsClient, setActiveWsClient] = useState<Client | null>(null);
  const clientRef = useRef<Client | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<KioskConnectionStatus>('connecting');
  // The presence store lives outside React's render tree so a single board's
  // event notifies only its own subscribers — one wall going live doesn't
  // re-render every other board's art. Created once for the hub's lifetime.
  const [store] = useState(createKioskPresenceStore);

  useEffect(() => {
    if (!hasBoards) return;
    // Wait for the ws-auth query to settle before building the client. For an
    // anonymous TV the token resolves to null with no state change afterwards,
    // so gating here avoids a build→dispose churn of an extra ws connection on
    // every boot (token would otherwise flip loading→settled once).
    if (isTokenLoading) return;
    const wsUrl = getBackendWsUrl();
    if (!wsUrl) return;

    const client = createGraphQLClient({ url: wsUrl, authToken: token, connectionName: 'kiosk' });
    // Drive the header's reconnect chip off the socket lifecycle. graphql-ws
    // retries with backoff internally; we only surface the state.
    const offConnected = client.on('connected', () => setConnectionStatus('connected'));
    const offClosed = client.on('closed', () => setConnectionStatus('reconnecting'));

    clientRef.current = client;
    setActiveWsClient(client);

    return () => {
      offConnected();
      offClosed();
      void client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      setActiveWsClient((currentClient) => (currentClient === client ? null : currentClient));
    };
  }, [token, hasBoards, isTokenLoading]);

  const presenceClient = useMemo<WebBoardPresenceClient | null>(() => {
    if (activeWsClient === null) return null;
    return createWebBoardPresenceClient(() => {
      const client = clientRef.current;
      if (!client) {
        throw new Error('Kiosk presence WS client is not connected yet');
      }
      return client;
    });
  }, [activeWsClient]);

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
