import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { type Client } from '@/app/lib/realtime/graphql-client';
import {
  createSessionConnectionController,
  hasContiguousReplayCoverage,
  type QueueSyncGate,
} from '@boardsesh/queue-runtime';
import type { SubscriptionQueueEvent, SessionEvent, SessionSummary } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { setPreference, removePreference } from '@/app/lib/user-preferences-db';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { END_SESSION as END_SESSION_GQL, type EndSessionResponse } from '@boardsesh/graphql/operations/sessions';
import { fetchAutoFinishedSummary } from './use-queue-storage';
import { getBrowserTimezone } from '@/app/lib/browser-timezone';
import { createWebSessionConnectionDeps } from './session-connection-ports';
import {
  type Session,
  type ActiveSessionInfo,
  type PendingInitialQueue,
  type SharedRefs,
  ACTIVE_SESSION_KEY,
  DEFAULT_BACKEND_URL,
  DEBUG,
} from '../types';

// The GraphQL-operation-shaped pieces this hook used to define inline
// (`transformToSubscriptionEvent`, `applySessionEvent`, and every
// `SessionConnectionDeps` port implementation) now live in
// `session-connection-ports.ts` — this hook is a thin React binding around
// `@boardsesh/queue-runtime`'s `createSessionConnectionController`. Re-export
// `applySessionEvent`/`transformToSubscriptionEvent` so existing importers
// (e.g. `session-lifecycle-replay.test.ts`, `session-events.test.tsx`) keep
// working unchanged.
export { applySessionEvent, transformToSubscriptionEvent } from './session-connection-ports';
// `hasContiguousReplayCoverage` moved to `@boardsesh/queue-runtime`'s
// `sync-gate.ts` (Workstream W2); re-exported here for the same reason.
export { hasContiguousReplayCoverage };

type UseSessionLifecycleArgs = {
  isAuthLoading: boolean;
  /**
   * Whether the WS auth token is currently present (`Boolean(token)`), NOT the
   * token string. The connection effect lists this so a null→token recovery
   * tears the anonymous controller down and rebuilds it authenticated (the ref
   * carries the fresh token by rebuild time). A boolean (not the string) so a
   * rotating JWT doesn't churn a healthy authenticated socket.
   */
  hasWsAuthToken: boolean;
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  /**
   * Shared sync gate owned by `PersistentSessionProvider`. This hook asks it
   * for the reconnect strategy (via the controller) and RESETS it whenever
   * the connection effect tears down (session change, auth change, unmount)
   * — the next connect re-establishes tracking from a fresh FullSync.
   */
  syncGate: QueueSyncGate;
  refs: Pick<
    SharedRefs,
    | 'wsAuthTokenRef'
    | 'usernameRef'
    | 'avatarUrlRef'
    | 'sessionRef'
    | 'activeSessionRef'
    | 'queueRef'
    | 'currentClimbQueueItemRef'
    | 'triggerResyncRef'
    | 'lastReceivedSequenceRef'
  >;
};

export type SessionLifecycleState = {
  activeSession: ActiveSessionInfo | null;
  client: Client | null;
  session: Session | null;
  isConnecting: boolean;
  hasConnected: boolean;
  error: Error | null;
  sessionSummary: SessionSummary | null;
  sessionSummaryBoardType: string | null;
  sessionSummaryHealthKitWorkoutId: string | null;
  sessionSummaryAutoFinished: boolean;
};

export type SessionLifecycleActions = {
  activateSession: (info: ActiveSessionInfo) => void;
  deactivateSession: (options?: { notifyServer?: boolean }) => void;
  setInitialQueueForSession: (
    sessionId: string,
    queue: LocalClimbQueueItem[],
    currentClimb: LocalClimbQueueItem | null,
    sessionName?: string,
  ) => void;
  endSessionWithSummary: (override?: { sessionId?: string | null; boardType?: string | null }) => void;
  setAutoFinishedSummary: (summary: SessionSummary, boardType: string | null) => void;
  dismissSessionSummary: () => void;
  setSession: Dispatch<SetStateAction<Session | null>>;
};

export function useSessionLifecycle({
  isAuthLoading,
  hasWsAuthToken,
  handleQueueEvent,
  handleSessionEvent,
  syncGate,
  refs,
}: UseSessionLifecycleArgs): SessionLifecycleState & SessionLifecycleActions {
  const {
    wsAuthTokenRef,
    usernameRef,
    avatarUrlRef,
    sessionRef,
    activeSessionRef,
    queueRef,
    currentClimbQueueItemRef,
    triggerResyncRef,
    lastReceivedSequenceRef,
  } = refs;

  const [activeSession, setActiveSession] = useState<ActiveSessionInfo | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [sessionSummaryBoardType, setSessionSummaryBoardType] = useState<string | null>(null);
  const [sessionSummaryHealthKitWorkoutId, setSessionSummaryHealthKitWorkoutId] = useState<string | null>(null);
  const [sessionSummaryAutoFinished, setSessionSummaryAutoFinished] = useState(false);
  const sendLeaveOnCleanupRef = useRef(false);

  // Pending initial queue for new sessions. This intentionally lives in a ref
  // so session activation and queue seeding can happen in either order without
  // the WebSocket effect capturing a stale null value.
  const pendingInitialQueueRef = useRef<PendingInitialQueue | null>(null);

  // Keep refs in sync
  useEffect(() => {
    sessionRef.current = session;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionRef is a stable ref
  }, [session]);
  useEffect(() => {
    activeSessionRef.current = activeSession;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeSessionRef is a stable ref
  }, [activeSession]);

  // Session lifecycle functions
  const activateSession = useCallback((info: ActiveSessionInfo) => {
    setActiveSession((prev) => {
      if (prev?.sessionId === info.sessionId && prev?.boardPath === info.boardPath) {
        return prev;
      }
      if (prev) {
        sendLeaveOnCleanupRef.current = true;
      }
      if (DEBUG) console.info('[PersistentSession] Activating session:', info.sessionId);
      setPreference(ACTIVE_SESSION_KEY, info).catch((err) =>
        console.error('[PersistentSession] Failed to persist session:', err),
      );
      return info;
    });
  }, []);

  const deactivateSession = useCallback((options?: { notifyServer?: boolean }) => {
    if (DEBUG) console.info('[PersistentSession] Deactivating session');
    if (options?.notifyServer !== false) {
      sendLeaveOnCleanupRef.current = true;
    }
    setActiveSession(null);
    removePreference(ACTIVE_SESSION_KEY).catch((err) =>
      console.error('[PersistentSession] Failed to clear persisted session:', err),
    );
  }, []);

  const setInitialQueueForSession = useCallback(
    (
      sessionId: string,
      queue: LocalClimbQueueItem[],
      currentClimb: LocalClimbQueueItem | null,
      sessionName?: string,
    ) => {
      if (DEBUG)
        console.info(
          `[PersistentSession] Setting initial queue for session ${sessionId}:`,
          queue.length,
          'items',
          sessionName ? `name: ${sessionName}` : '',
        );
      pendingInitialQueueRef.current = { sessionId, queue, currentClimb, sessionName };
    },
    [],
  );

  const dismissSessionSummary = useCallback(() => {
    setSessionSummary(null);
    setSessionSummaryBoardType(null);
    setSessionSummaryHealthKitWorkoutId(null);
    setSessionSummaryAutoFinished(false);
  }, []);

  const setAutoFinishedSummary = useCallback((summary: SessionSummary, boardType: string | null) => {
    setSessionSummary(summary);
    setSessionSummaryBoardType(boardType);
    setSessionSummaryHealthKitWorkoutId(null);
    setSessionSummaryAutoFinished(true);
  }, []);

  // `override` lets a caller end a session the persistent provider never
  // activated — the board-route path (`use-session-id-management`) can hold a
  // session id in the cookie before `BoardSessionBridge` activates it, so
  // `activeSessionRef.current` is null there. The override supplies that id (and
  // its board type) directly. When omitted, we fall back to the active session.
  const endSessionWithSummary = useCallback(
    (override?: { sessionId?: string | null; boardType?: string | null }) => {
      const endingSessionId = override?.sessionId ?? activeSessionRef.current?.sessionId;
      const boardType = override?.boardType ?? activeSessionRef.current?.parsedParams.board_name ?? null;
      const token = wsAuthTokenRef.current;

      deactivateSession({ notifyServer: false });

      if (endingSessionId && token) {
        const httpClient = createGraphQLHttpClient(token);
        httpClient
          .request<EndSessionResponse>(END_SESSION_GQL, { sessionId: endingSessionId, timezone: getBrowserTimezone() })
          .then((response) => {
            if (response.endSession) {
              setSessionSummary(response.endSession);
              setSessionSummaryBoardType(boardType);
              setSessionSummaryHealthKitWorkoutId(null);
              setSessionSummaryAutoFinished(false);
            }
          })
          .catch((err) => {
            console.error('[PersistentSession] Failed to get session summary:', err);
          });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, only .current changes
    [deactivateSession],
  );

  // Re-run the auto-finished pre-flight when the tab returns to visible — backend may have swept the session.
  const visibilityCheckInFlightRef = useRef(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;

    async function checkIfAutoFinished() {
      if (visibilityCheckInFlightRef.current) return;
      const active = activeSessionRef.current;
      if (!active) return;
      visibilityCheckInFlightRef.current = true;
      try {
        const result = await fetchAutoFinishedSummary(active, wsAuthTokenRef.current);
        if (!result) return;
        if (activeSessionRef.current?.sessionId !== active.sessionId) return;
        deactivateSession({ notifyServer: false });
        setAutoFinishedSummary(result.summary, result.boardType);
      } finally {
        visibilityCheckInFlightRef.current = false;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') void checkIfAutoFinished();
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) void checkIfAutoFinished();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);

    // BFCache restore: the browser fires `pageshow` with persisted=true after
    // bindings are restored, but if the user navigated back/forward into this
    // page before React's effect attached the listener, the event is lost.
    // Detect via the Performance API and run the check once on mount.
    if (typeof performance !== 'undefined') {
      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navEntry?.type === 'back_forward') {
        void checkIfAutoFinished();
      }
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, callbacks are useCallback([])-stable
  }, [deactivateSession, setAutoFinishedSummary]);

  // Connect to session when activeSession changes. Instantiates a fresh
  // `SessionConnectionController` per (activeSession, isAuthLoading,
  // hasWsAuthToken, ...) effect run — the controller owns
  // connect/join/subscribe/reconnect/retry (see
  // `@boardsesh/queue-runtime/session-connection.ts` for that state machine and
  // its ownership-split doc comment); this effect wires the controller's ports
  // (built by `createWebSessionConnectionDeps`) to React state and starts/stops
  // it. `hasWsAuthToken` is in the deps so a null→token recovery re-runs this
  // effect: the cleanup tears down the anonymous controller and start()
  // rebuilds it with the now-present token (read from `wsAuthTokenRef.current`
  // inside `createWebSessionConnectionDeps`). Recreating through the existing
  // teardown path — never a second controller alongside the first — is
  // deliberate: a double controller would itself inflate presence.
  useEffect(() => {
    if (!activeSession) {
      if (DEBUG) console.info('[PersistentSession] No active session, skipping connection');
      return;
    }
    if (isAuthLoading) {
      if (DEBUG) console.info('[PersistentSession] Waiting for auth to load...');
      return;
    }
    const backendUrl = DEFAULT_BACKEND_URL;
    if (!backendUrl) {
      if (DEBUG) console.info('[PersistentSession] No backend URL configured');
      return;
    }

    const controller = createSessionConnectionController(
      createWebSessionConnectionDeps({
        activeSession,
        backendUrl,
        syncGate,
        refs: { wsAuthTokenRef, usernameRef, avatarUrlRef, queueRef, currentClimbQueueItemRef },
        pendingInitialQueueRef,
        handleQueueEvent,
        handleSessionEvent,
        setActiveSession,
        setClient,
        setSession,
        setIsConnecting,
        setError,
        setHasConnected,
      }),
    );

    triggerResyncRef.current = () => controller.triggerResync();
    controller.start();

    return () => {
      if (DEBUG) console.info('[PersistentSession] Cleaning up connection');
      const shouldSendLeave = sendLeaveOnCleanupRef.current;
      sendLeaveOnCleanupRef.current = false;
      controller.stop({ sendLeave: shouldSendLeave });

      // Gate tracking is connection-scoped: the next connect() (same or
      // different session) re-establishes sequence/hash tracking from a
      // fresh FullSync, and a new session deserves a clean corruption
      // cooldown and resync-loop counter. Transient socket drops do NOT run
      // this cleanup (graphql-ws reconnects internally via onReconnect), so
      // delta replay across a network blip still sees the pre-disconnect
      // sequence. The gate is owned by `PersistentSessionProvider` (shared
      // with the event processor and subscriptions hook), so resetting it
      // stays here rather than moving into the controller — see the
      // ownership-split doc comment on `createSessionConnectionController`.
      syncGate.reset();
      lastReceivedSequenceRef.current = null;

      setClient(null);
      setSession(null);
      setHasConnected(false);
      setIsConnecting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, only .current changes; intentional dep list
  }, [activeSession, isAuthLoading, hasWsAuthToken, handleQueueEvent, handleSessionEvent, syncGate, setSession]);

  return {
    activeSession,
    client,
    session,
    isConnecting,
    hasConnected,
    error,
    sessionSummary,
    sessionSummaryBoardType,
    sessionSummaryHealthKitWorkoutId,
    sessionSummaryAutoFinished,
    activateSession,
    deactivateSession,
    setInitialQueueForSession,
    endSessionWithSummary,
    setAutoFinishedSummary,
    dismissSessionSummary,
    setSession,
  };
}
