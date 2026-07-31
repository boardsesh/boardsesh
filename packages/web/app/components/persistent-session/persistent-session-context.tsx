'use client';

import React, { createContext, useContext, useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
import { createQueueSyncGate, type QueueSyncGate } from '@boardsesh/queue-runtime';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../queue-control/types';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { usePartyProfile } from '../party-manager/party-profile-context';
import { isBoardRoutePath } from '@/app/lib/board-route-paths';

import type {
  PersistentSessionContextType,
  PersistentSessionActionsType,
  PersistentSessionStateType,
  Session,
  ActiveSessionInfo,
  SharedRefs,
} from './types';
import { useEventProcessor } from './hooks/use-event-processor';
import { useQueueStorage } from './hooks/use-queue-storage';
import { useQueueMutations } from './hooks/use-queue-mutations';
import { useRateLimitSnackbar } from './hooks/use-rate-limit-snackbar';
import { useSessionSubscriptions } from './hooks/use-session-subscriptions';
import { useSessionLifecycle } from './hooks/use-session-lifecycle';
import { usePendingUpdateCleanup } from './hooks/use-pending-update-cleanup';
import { usePeerBroadcastAnalytics } from './hooks/use-peer-broadcast-analytics';

// Re-export types for backwards compatibility
export type {
  PersistentSessionContextType,
  PersistentSessionActionsType,
  PersistentSessionStateType,
  Session,
  ActiveSessionInfo,
} from './types';

// Split contexts: actions (stable) vs state (changes frequently)
const PersistentSessionActionsContext = createContext<PersistentSessionActionsType | undefined>(undefined);
const PersistentSessionStateContext = createContext<PersistentSessionStateType | undefined>(undefined);
// Combined context for backward compatibility
const PersistentSessionContext = createContext<PersistentSessionContextType | undefined>(undefined);

export const PersistentSessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token: wsAuthToken, isLoading: isAuthLoading } = useWsAuthToken();
  const { username, avatarUrl } = usePartyProfile();
  const pathname = usePathname();

  // Shared refs used across hooks
  const offlineBufferRef = useRef<LocalClimbQueueItem[]>([]);
  const wsAuthTokenRef = useRef(wsAuthToken);
  const usernameRef = useRef(username);
  const avatarUrlRef = useRef(avatarUrl);
  const sessionRef = useRef<Session | null>(null);
  const activeSessionRef = useRef<ActiveSessionInfo | null>(null);
  const queueRef = useRef<LocalClimbQueueItem[]>([]);
  const currentClimbQueueItemRef = useRef<LocalClimbQueueItem | null>(null);
  const triggerResyncRef = useRef<(() => void) | null>(null);
  const lastReceivedSequenceRef = useRef<number | null>(null);
  const queueEventSubscribersRef = useRef<Set<(event: SubscriptionQueueEvent) => void>>(new Set());
  const sessionEventSubscribersRef = useRef<Set<(event: SessionEvent) => void>>(new Set());

  // Keep auth ref in sync. The graphql-ws connectionParams are baked in at
  // connect-time from `wsAuthTokenRef.current`, so when the token recovers
  // *after* the lifecycle hook already established an anonymous connection, the
  // socket has to be rebuilt to send the token. The lifecycle effect depends on
  // `hasWsAuthToken` (below) — a null→token transition flips it, tearing the
  // anonymous socket down and reconnecting authenticated. This ref effect is
  // registered before the lifecycle effect, so the ref already carries the
  // fresh token by the time the rebuild reads it.
  useEffect(() => {
    wsAuthTokenRef.current = wsAuthToken;
  }, [wsAuthToken]);
  useEffect(() => {
    usernameRef.current = username;
  }, [username]);
  useEffect(() => {
    avatarUrlRef.current = avatarUrl;
  }, [avatarUrl]);

  const refs: SharedRefs = {
    offlineBufferRef,
    wsAuthTokenRef,
    usernameRef,
    avatarUrlRef,
    sessionRef,
    activeSessionRef,
    queueRef,
    currentClimbQueueItemRef,
    triggerResyncRef,
    lastReceivedSequenceRef,
    queueEventSubscribersRef,
    sessionEventSubscribersRef,
  };

  // Shared queue sync gate — ONE instance for all three hooks below, so
  // sequence/hash tracking, the corruption cooldown, and the resync-loop
  // backoff read the same state. Ownership: created here (lazily, once per
  // provider mount); the event processor advances it per applied event; the
  // lifecycle consults it on reconnect and RESETS it when the connection
  // effect tears down (session change/disconnect); the subscriptions hook
  // consumes its watchdog/corruption verdicts.
  const syncGateRef = useRef<QueueSyncGate | null>(null);
  if (syncGateRef.current === null) {
    syncGateRef.current = createQueueSyncGate();
  }
  const syncGate = syncGateRef.current;

  // 1. Event processor: queue state (shared queueReducer) + event handling
  const eventProcessor = useEventProcessor({ syncGate, refs });

  // Keep queue refs in sync with event processor state. Assigned DURING RENDER
  // (not in a useEffect) so the refs are current before paint. Peer queue
  // events fire synchronously through the subscription and read these refs in
  // the same tick as the queue mutation they carry — e.g.
  // `use-peer-broadcast-analytics` reads `queueRef.current.length`. A post-paint
  // useEffect assignment leaves the ref one render behind, so the analytics
  // would report the pre-event queue length. Assign-during-render matches the
  // sibling refs in this provider tree (`activeSessionRef`/`boardContextRef`)
  // and restores the behavior of the deleted `use-queue-event-subscription`
  // hook, which updated its length ref in the render body.
  queueRef.current = eventProcessor.queue;
  currentClimbQueueItemRef.current = eventProcessor.currentClimbQueueItem;

  // 2. Session lifecycle: connect/disconnect, join/leave.
  // Pass token *presence* (not the token string): a null→token recovery must
  // rebuild the socket, but the raw NextAuth JWT can rotate on refetch
  // (staleTime + refetchOnWindowFocus) and a string dep would needlessly tear
  // down a healthy authenticated socket on every rotation.
  const hasWsAuthToken = Boolean(wsAuthToken);
  const lifecycle = useSessionLifecycle({
    isAuthLoading,
    hasWsAuthToken,
    handleQueueEvent: eventProcessor.handleQueueEvent,
    handleSessionEvent: eventProcessor.handleSessionEvent,
    syncGate,
    refs,
  });

  // Stable wrapper: the queue-storage restore effect lists this in its dep
  // array, so a fresh inline arrow each render would re-fire the effect and
  // open a race window between `isAuthLoading` flipping false and
  // `hasRunPreflightRef` being set.
  const handleQueueStorageSetActiveSession = useCallback(
    (val: ActiveSessionInfo) => {
      lifecycle.activateSession(val);
    },
    [lifecycle.activateSession],
  );

  // 3. Queue storage: board-context bookkeeping (which board the root-owned
  // solo queue belongs to). The queue itself lives in the event processor's
  // reducer (step 1) — this hook no longer stores a separate copy.
  const queueStorage = useQueueStorage({
    activeSession: lifecycle.activeSession,
    setActiveSession: handleQueueStorageSetActiveSession,
    onSessionAutoFinished: lifecycle.setAutoFinishedSummary,
    wsAuthToken,
    isAuthLoading,
    dispatch: eventProcessor.dispatch,
  });

  // 4. Queue mutations: GraphQL mutation wrappers. `onRateLimited` surfaces a
  // debounced "catching up" snackbar while a throttled mutation backs off to
  // retry (e.g. a reconnect burst of buffered adds), instead of the alarming
  // generic failure toast (#2655).
  const onRateLimited = useRateLimitSnackbar();
  const mutations = useQueueMutations({
    client: lifecycle.client,
    session: lifecycle.session,
    // Positions a deferred queue-add (superseded or drained-then-throttled
    // activation) where this client shows it, so peers get the same order
    // (#3936). Same reducer state `queueRef` above mirrors.
    queue: eventProcessor.queue,
    onRateLimited,
  });

  // 5. Session subscriptions: periodic verification, event subscriptions, corruption checks
  const subscriptions = useSessionSubscriptions({
    session: lifecycle.session,
    queue: eventProcessor.queue,
    currentClimbQueueItem: eventProcessor.currentClimbQueueItem,
    lastReceivedStateHash: eventProcessor.lastReceivedStateHash,
    needsResync: eventProcessor.needsResync,
    clearResyncFlag: eventProcessor.clearResyncFlag,
    syncGate,
    refs,
  });

  // 6. Pending-update cleanup: garbage-collects orphaned correlation ids on
  // the current-climb mutation. Moved here from the board-route provider —
  // `pendingCurrentClimbUpdates` lives in root state now, so the cleanup has
  // to run wherever that state lives, on and off board routes alike.
  usePendingUpdateCleanup({
    isPersistentSessionActive: !!lifecycle.session,
    pendingCurrentClimbUpdates: eventProcessor.pendingCurrentClimbUpdates,
    dispatch: eventProcessor.dispatch,
    onStalePendingUpdates: subscriptions.triggerResync,
  });

  // 7. Peer-broadcast queue-add/-remove analytics, board-route-gated. See
  // `use-peer-broadcast-analytics.ts` for the full rationale (moved from the
  // deleted board-route hook `use-queue-event-subscription.ts`; the gate is
  // the one piece of behavior that needs restating now that this runs at the
  // always-mounted root instead of only inside board-route-scoped
  // `GraphQLQueueProvider`).
  // `boardLayoutName` is sourced from the active session's board rather than the
  // mounted route's board details (the old hook read the route's `boardDetails`
  // from `GraphQLQueueProvider`). These agree while browsing the session's own
  // board; they can differ if a member browses a *different* board route than
  // the session board, in which case the analytics tag reflects the session
  // board. Acceptable for an attribution tag; noted so it isn't mistaken for a
  // bug.
  usePeerBroadcastAnalytics({
    subscribeToQueueEvents: subscriptions.subscribeToQueueEvents,
    isOnBoardRoute: isBoardRoutePath(pathname),
    boardLayoutName: lifecycle.activeSession?.boardDetails.layout_name ?? null,
    queueRef,
    // Our joinSession-returned connection id — the same value the backend
    // stamps onto QueueItemRemoved, so the hook can drop echoes of our own
    // removes instead of mislabelling them as a peer's (#3382).
    clientId: lifecycle.session?.clientId ?? null,
  });

  // Session-scoped "the wall is lit" indicator, owned here (root, always
  // mounted) so it survives leaving/remounting a board route. Set from session
  // events; reset whenever the active session changes/ends. The board-route
  // queue provider and the off-board queue bridge both read it, so the
  // persistent bar/drawer lightbulb is consistent everywhere.
  const [isSessionWallLit, setIsSessionWallLit] = useState(false);
  const activeSessionId = lifecycle.session?.id ?? null;
  useEffect(() => {
    setIsSessionWallLit(false);
    const unsubscribe = subscriptions.subscribeToSessionEvents((event: SessionEvent) => {
      if (event.__typename === 'WallConfirmedClimb') {
        setIsSessionWallLit(true);
      } else if (event.__typename === 'WallDisconnected' || event.__typename === 'SessionEnded') {
        setIsSessionWallLit(false);
      }
    });
    return unsubscribe;
  }, [activeSessionId, subscriptions.subscribeToSessionEvents]);

  // --- Actions context value (stable — functions from hooks are already memoized) ---
  const actionsValue = useMemo<PersistentSessionActionsType>(
    () => ({
      activateSession: lifecycle.activateSession,
      deactivateSession: lifecycle.deactivateSession,
      setInitialQueueForSession: lifecycle.setInitialQueueForSession,
      addQueueItem: mutations.addQueueItem,
      removeQueueItem: mutations.removeQueueItem,
      setCurrentClimb: mutations.setCurrentClimb,
      mirrorCurrentClimb: mutations.mirrorCurrentClimb,
      publishPlaybackState: mutations.publishPlaybackState,
      setQueue: mutations.setQueue,
      replaceQueueItem: mutations.replaceQueueItem,
      confirmClimbOnWall: mutations.confirmClimbOnWall,
      reportWallDisconnect: mutations.reportWallDisconnect,
      setSessionBoardSerial: mutations.setSessionBoardSerial,
      setSessionBoardPath: mutations.setSessionBoardPath,
      dispatch: eventProcessor.dispatch,
      setBoardContext: queueStorage.setBoardContext,
      subscribeToQueueEvents: subscriptions.subscribeToQueueEvents,
      subscribeToSessionEvents: subscriptions.subscribeToSessionEvents,
      triggerResync: subscriptions.triggerResync,
      endSessionWithSummary: lifecycle.endSessionWithSummary,
      dismissSessionSummary: lifecycle.dismissSessionSummary,
      setAutoFinishedSummary: lifecycle.setAutoFinishedSummary,
    }),
    [
      lifecycle.activateSession,
      lifecycle.deactivateSession,
      lifecycle.setInitialQueueForSession,
      lifecycle.endSessionWithSummary,
      lifecycle.dismissSessionSummary,
      lifecycle.setAutoFinishedSummary,
      mutations.addQueueItem,
      mutations.removeQueueItem,
      mutations.setCurrentClimb,
      mutations.mirrorCurrentClimb,
      mutations.publishPlaybackState,
      mutations.setQueue,
      mutations.replaceQueueItem,
      mutations.confirmClimbOnWall,
      mutations.reportWallDisconnect,
      mutations.setSessionBoardSerial,
      mutations.setSessionBoardPath,
      eventProcessor.dispatch,
      queueStorage.setBoardContext,
      subscriptions.subscribeToQueueEvents,
      subscriptions.subscribeToSessionEvents,
      subscriptions.triggerResync,
    ],
  );

  // --- State context value (changes when session/queue state changes) ---
  const stateValue = useMemo<PersistentSessionStateType>(
    () => ({
      activeSession: lifecycle.activeSession,
      session: lifecycle.session,
      isConnecting: lifecycle.isConnecting,
      hasConnected: lifecycle.hasConnected,
      error: lifecycle.error,
      clientId: lifecycle.session?.clientId ?? null,
      participantId: lifecycle.session?.participantId ?? null,
      isLeader: lifecycle.session?.isLeader ?? false,
      users: lifecycle.session?.users ?? [],
      isSessionWallLit,
      currentClimbQueueItem: eventProcessor.currentClimbQueueItem,
      queue: eventProcessor.queue,
      playlistSuggestionSource: eventProcessor.playlistSuggestionSource,
      pendingCurrentClimbUpdates: eventProcessor.pendingCurrentClimbUpdates,
      soloBoardPath: queueStorage.soloBoardPath,
      soloBoardDetails: queueStorage.soloBoardDetails,
      isSessionRestoreComplete: queueStorage.isSessionRestoreComplete,
      offlineBufferRef,
      lastReceivedSequenceRef,
      sessionSummary: lifecycle.sessionSummary,
      sessionSummaryBoardType: lifecycle.sessionSummaryBoardType ?? null,
      sessionSummaryHealthKitWorkoutId: lifecycle.sessionSummaryHealthKitWorkoutId ?? null,
      sessionSummaryAutoFinished: lifecycle.sessionSummaryAutoFinished,
    }),
    [
      lifecycle.activeSession,
      lifecycle.session,
      lifecycle.isConnecting,
      lifecycle.hasConnected,
      lifecycle.error,
      lifecycle.sessionSummary,
      lifecycle.sessionSummaryBoardType,
      lifecycle.sessionSummaryHealthKitWorkoutId,
      lifecycle.sessionSummaryAutoFinished,
      isSessionWallLit,
      eventProcessor.currentClimbQueueItem,
      eventProcessor.queue,
      eventProcessor.playlistSuggestionSource,
      eventProcessor.pendingCurrentClimbUpdates,
      queueStorage.soloBoardPath,
      queueStorage.soloBoardDetails,
      queueStorage.isSessionRestoreComplete,
    ],
  );

  // --- Combined context value for backward compatibility ---
  const value = useMemo<PersistentSessionContextType>(
    () => ({ ...stateValue, ...actionsValue }),
    [stateValue, actionsValue],
  );

  return (
    <PersistentSessionActionsContext.Provider value={actionsValue}>
      <PersistentSessionStateContext.Provider value={stateValue}>
        <PersistentSessionContext.Provider value={value}>{children}</PersistentSessionContext.Provider>
      </PersistentSessionStateContext.Provider>
    </PersistentSessionActionsContext.Provider>
  );
};

// --- Targeted hooks (prefer these for performance) ---

export function usePersistentSessionActions() {
  const context = useContext(PersistentSessionActionsContext);
  if (!context) {
    throw new Error('usePersistentSessionActions must be used within a PersistentSessionProvider');
  }
  return context;
}

export function usePersistentSessionState() {
  const context = useContext(PersistentSessionStateContext);
  if (!context) {
    throw new Error('usePersistentSessionState must be used within a PersistentSessionProvider');
  }
  return context;
}

// --- Backward-compatible hook (subscribes to everything) ---

export function usePersistentSession() {
  const context = useContext(PersistentSessionContext);
  if (!context) {
    throw new Error('usePersistentSession must be used within a PersistentSessionProvider');
  }
  return context;
}

// Helper hook to check if we're on a board route
export function useIsOnBoardRoute() {
  const pathname = usePathname();
  return isBoardRoutePath(pathname);
}
