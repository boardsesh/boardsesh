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
// supervises two failure shapes the library cannot see:
//
//  a) THE SOCKET IS DOWN past PRESENCE_REBUILD_AFTER_MS (retry budget spent).
//  b) THE SOCKET IS UP but ONE BOARD's subscription is dead. graphql-ws does
//     not retry an operation the server rejected with a GraphQL error (its
//     subscribe loop treats `Error` as terminal), and a multi-board TV keeps
//     the socket alive on its other boards — so no `closed` ever fires. That
//     slot then shows whatever it last saw forever, including a climb the wall
//     has since cleared (a clear only ever arrives over the live stream).
//
// Both end in the same move: dispose the client and build a fresh one, which
// re-subscribes every board. Rebuilding costs the wall its state — the shared
// `useBoardPresence` RESETs when the client identity changes — so the hub
// tells every board to catch up on the rebuilt client's first connect (see
// `catchUpNonce`). Without that the screen comes back permanently blank,
// because the rebuild happens BY CONSTRUCTION while the backend is
// unreachable, so the providers' own backfill seeds fail.
//
// Costs, stated plainly: each generation gets a fresh 11-attempt budget (the
// initial connect plus `retryAttempts: 10`), so an outage that outlives the
// first window costs one extra burst of up to 11 attempts per rebuild instead
// of the single burst a supervisor-less client spends. With the jittered window
// averaging ~3.75 min, a 12-minute outage is on the order of 40 attempts rather
// than 11 — spread over those 12 minutes, comfortably inside
// `boardNowPlaying`'s 60/min anon bucket. The jitter is what keeps that from
// arriving as one synchronized fleet-wide burst. Case (b) is capped at
// MAX_STALE_SUBSCRIPTION_REBUILDS because a board the backend will never serve
// again (flipped private mid-session) would otherwise churn the whole client
// every 5 minutes for the rest of the day.
//
// Longer/other outages are covered by kiosk-reliability.tsx — but only on the
// kiosk routes: `/embed/**` mounts this hub WITHOUT `KioskReliability`, so an
// embed gets layer 1 (the per-board catch-up that ships inside
// `KioskBoardFeedBridge`) and this supervisor, and neither the config-poll nor
// the 04:00 reload.

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BoardPresenceProvider } from '@boardsesh/board-presence-react';
import { RECONNECT_JITTER_RATIO } from '@boardsesh/graphql-client';
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

/**
 * How many times in a row a still-dead board subscription may force a client
 * rebuild before the hub stops trying. A transient rejection (the shared anon
 * `ip:` rate bucket every TV in the gym shares) clears in one; a board flipped
 * private mid-session never will, and without this cap that slot would rebuild
 * the whole client — blanking every OTHER board for a round trip — every five
 * minutes until the 04:00 reload. The counter resets the moment every board is
 * live again.
 */
export const MAX_STALE_SUBSCRIPTION_REBUILDS = 3;

/**
 * The rebuild countdown, jittered. A backend restart takes every TV in the
 * fleet down at the same instant, so an un-jittered constant would have them
 * all rebuild — and, because a freshly built graphql-ws client does not wait
 * before its FIRST attempt, all reconnect — in one synchronized burst every
 * five minutes for as long as the outage lasts. Same ratio the transport's own
 * `retryWait` uses (#2655), so the two backoff layers stay consistent:
 * `randomFraction` of 0 keeps the full window, 1 halves it.
 */
export function presenceRebuildDelayMs(randomFraction: number): number {
  const clamped = Math.min(Math.max(randomFraction, 0), 1);
  return Math.round(PRESENCE_REBUILD_AFTER_MS * (1 - clamped * RECONNECT_JITTER_RATIO));
}

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
  // Read at decision time by the liveness supervisor, which runs outside
  // render. The gym-manage preview edits its slot list live, so a board can
  // leave the tree while its last-known liveness is still on the books.
  const boardIdsRef = useRef(boardIds);
  boardIdsRef.current = boardIds;

  const [activeWsClient, setActiveWsClient] = useState<Client | null>(null);
  const clientRef = useRef<Client | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<KioskConnectionStatus>('connecting');
  // The presence store lives outside React's render tree so a single board's
  // event notifies only its own subscribers — one wall going live doesn't
  // re-render every other board's art. Created once for the hub's lifetime.
  const [store] = useState(createKioskPresenceStore);
  // Bumped when either supervisor gives up on a client. It is an effect dep, so
  // a bump tears the old client down and builds a fresh one — graphql-ws's
  // retry counter back at zero, and every BoardPresenceProvider re-subscribing.
  // Re-subscribing is NOT re-backfilling: the providers also RESET, and their
  // own seeds run against a backend that is still down. `catchUpNonce` below is
  // what actually refills the screen.
  const [clientGeneration, setClientGeneration] = useState(0);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the socket is up right now, readable from a cleanup closure and
  // from the liveness supervisor (both run outside render).
  const socketOpenRef = useRef(false);
  // Boards whose own subscription is dead while the socket is fine (case (b)
  // in the header), the countdown that acts on them, and how many rebuilds
  // that countdown has already spent.
  const deadBoardsRef = useRef<Set<number>>(new Set());
  const staleSubscriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleSubscriptionRebuildsRef = useRef(0);
  // When every board was last simultaneously live. Drives the budget reset — a
  // healthy stretch is what makes the NEXT dead board a new incident rather
  // than the same one still failing.
  const allBoardsLiveSinceRef = useRef(Number.NEGATIVE_INFINITY);
  // Bumped when a REBUILT client first connects. `KioskBoardFeedBridge` reads
  // it and re-runs its board's catch-up, which is the only thing that refills a
  // wall the rebuild reset — see the `connected` handler below for why the
  // providers' own backfill seeds cannot.
  const [catchUpNonce, setCatchUpNonce] = useState(0);

  const clearStaleSubscriptionTimer = useCallback(() => {
    if (staleSubscriptionTimerRef.current === null) return;
    clearTimeout(staleSubscriptionTimerRef.current);
    staleSubscriptionTimerRef.current = null;
  }, []);

  /**
   * Forget boards that are no longer rendered. A board whose provider unmounts
   * publishes no final snapshot, so without this its last known "dead" would
   * keep forcing rebuilds for a slot the editor already removed.
   */
  const pruneDeadBoards = useCallback(() => {
    const renderedBoardIds = new Set(boardIdsRef.current);
    for (const boardId of deadBoardsRef.current) {
      if (!renderedBoardIds.has(boardId)) {
        deadBoardsRef.current.delete(boardId);
      }
    }
  }, []);

  /**
   * Start (or stand down) the countdown on case (b). Called both when a board's
   * liveness changes and when the SOCKET connects — a board can go dead before
   * the socket is up (its first subscribe is rejected), and that ordering would
   * otherwise leave the countdown permanently unarmed.
   */
  const evaluateStaleSubscriptions = useCallback(() => {
    pruneDeadBoards();
    if (deadBoardsRef.current.size === 0) {
      clearStaleSubscriptionTimer();
      return;
    }
    // A dead SOCKET takes every board down with it; that is the other
    // countdown's job, and arming both would rebuild twice.
    if (!socketOpenRef.current) {
      clearStaleSubscriptionTimer();
      return;
    }
    if (staleSubscriptionRebuildsRef.current >= MAX_STALE_SUBSCRIPTION_REBUILDS) return;
    if (staleSubscriptionTimerRef.current !== null) return;
    staleSubscriptionTimerRef.current = setTimeout(() => {
      staleSubscriptionTimerRef.current = null;
      pruneDeadBoards();
      if (deadBoardsRef.current.size === 0 || !socketOpenRef.current) return;
      staleSubscriptionRebuildsRef.current += 1;
      setClientGeneration((generation) => generation + 1);
    }, presenceRebuildDelayMs(Math.random()));
  }, [clearStaleSubscriptionTimer, pruneDeadBoards]);

  /**
   * Called for every snapshot a board publishes. `isLive` is false exactly when
   * that board has no working subscription, so a board that stays false while
   * the socket is connected is case (b): a per-operation rejection graphql-ws
   * will never retry.
   */
  const noteBoardLiveness = useCallback(
    (boardId: number, isLive: boolean) => {
      // Prune BEFORE reading the set, so a removed board cannot make the
      // all-live transitions below read false when every rendered board is up.
      pruneDeadBoards();
      const deadBoards = deadBoardsRef.current;
      const wasAllLive = deadBoards.size === 0;
      if (isLive) {
        deadBoards.delete(boardId);
      } else {
        deadBoards.add(boardId);
      }
      const isAllLive = deadBoards.size === 0;

      if (isAllLive && !wasAllLive) {
        allBoardsLiveSinceRef.current = Date.now();
      } else if (!isAllLive && wasAllLive) {
        // A board just went dead. If the TV had been fully healthy for longer
        // than a rebuild window, this is a NEW incident and gets a fresh
        // budget. Deliberately NOT "reset whenever every board is live": a
        // rebuilt client reports every board live for the microtask before its
        // rejection lands, so that rule would hand a permanently-rejected board
        // an unlimited budget one tick at a time.
        if (Date.now() - allBoardsLiveSinceRef.current >= PRESENCE_REBUILD_AFTER_MS) {
          staleSubscriptionRebuildsRef.current = 0;
        }
      }

      evaluateStaleSubscriptions();
    },
    [evaluateStaleSubscriptions, pruneDeadBoards],
  );

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
    // Whether this generation has already asked its boards to catch up. Only
    // the first connect needs it; every later reconnect on the same client is
    // already covered by the presence client's own `onReconnect` catch-up.
    let hasRequestedRebuildCatchUp = false;
    // Drive the header's reconnect chip off the socket lifecycle. graphql-ws
    // retries with backoff internally; we only surface the state.
    const offConnected = client.on('connected', () => {
      clearRebuildTimer();
      socketOpenRef.current = true;
      setConnectionStatus('connected');
      // A rebuilt client is a NEW client identity, so every provider RESET its
      // wall and re-ran its backfill seeds — while the backend was still
      // unreachable, which is the only reason the rebuild fired. Those seeds
      // are best-effort and swallow their failure, and nothing refills them
      // afterwards: the presence factory treats a fresh client's first
      // `connected` as the initial connect and skips its reconnect catch-up,
      // and `boardNowPlaying` publishes no snapshot on subscribe. So the wall
      // would come back permanently blank. Ask each board to catch up.
      if (clientGeneration > 0 && !hasRequestedRebuildCatchUp) {
        hasRequestedRebuildCatchUp = true;
        setCatchUpNonce((nonce) => nonce + 1);
      }
      evaluateStaleSubscriptions();
    });
    const offClosed = client.on('closed', () => {
      socketOpenRef.current = false;
      setConnectionStatus('reconnecting');
      clearStaleSubscriptionTimer();
      // graphql-ws emits `closed` once per failed retry, so keep the FIRST
      // countdown running: the window measures time since the wall went dark,
      // not time since the latest attempt.
      if (rebuildTimerRef.current !== null) return;
      rebuildTimerRef.current = setTimeout(() => {
        rebuildTimerRef.current = null;
        setClientGeneration((generation) => generation + 1);
      }, presenceRebuildDelayMs(Math.random()));
    });

    clientRef.current = client;
    setActiveWsClient(client);

    return () => {
      clearRebuildTimer();
      clearStaleSubscriptionTimer();
      offConnected();
      offClosed();
      // graphql-ws's `dispose()` awaits the pending `connecting` promise before
      // it closes the socket, and that promise only settles on a
      // `connection_ack` — which `connectionAckWaitTimeout: 0` (the library
      // default the shared factory keeps) never times out. A proxy that accepts
      // the upgrade while the app behind it is restarting therefore leaves a
      // disposed client's socket OPEN for the life of the page, and the rebuild
      // path disposes mid-connect by construction. `terminate()` settles that
      // promise and closes the socket. Skipped while the socket is up so an
      // ordinary teardown still closes cleanly with 1000.
      if (!socketOpenRef.current) {
        client.terminate();
      }
      socketOpenRef.current = false;
      // The next generation's providers re-report from scratch. Stamp the
      // healthy-since clock too, so the budget reset above measures a real
      // healthy stretch rather than treating this bookkeeping as one.
      deadBoardsRef.current.clear();
      allBoardsLiveSinceRef.current = Date.now();
      void client.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      setActiveWsClient((currentClient) => (currentClient === client ? null : currentClient));
    };
    // Deps are primitives on purpose — `boardIds` is a fresh array identity on
    // every render, so listing it here would rebuild the socket per render.
  }, [
    authToken,
    hasBoards,
    isAuthResolving,
    clientGeneration,
    clearStaleSubscriptionTimer,
    evaluateStaleSubscriptions,
  ]);

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
      noteBoardLiveness(boardId, snapshot.isLive);
    },
    [store, noteBoardLiveness],
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
            <KioskBoardFeedBridge boardId={boardId} onSnapshot={publishSnapshot} catchUpNonce={catchUpNonce} />
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
