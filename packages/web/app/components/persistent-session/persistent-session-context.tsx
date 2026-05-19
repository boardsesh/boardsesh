'use client';

import React, { createContext, useContext, useCallback, useMemo, useRef, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
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
import { useSessionSubscriptions } from './hooks/use-session-subscriptions';
import { useSessionLifecycle } from './hooks/use-session-lifecycle';

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

  // Shared refs used across hooks
  const offlineBufferRef = useRef<LocalClimbQueueItem[]>([]);
  const wsAuthTokenRef = useRef(wsAuthToken);
  const usernameRef = useRef(username);
  const avatarUrlRef = useRef(avatarUrl);
  const sessionRef = useRef<Session | null>(null);
  const activeSessionRef = useRef<ActiveSessionInfo | null>(null);
  const queueRef = useRef<LocalClimbQueueItem[]>([]);
  const currentClimbQueueItemRef = useRef<LocalClimbQueueItem | null>(null);
  const mountedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const isReconnectingRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const triggerResyncRef = useRef<(() => void) | null>(null);
  const lastReceivedSequenceRef = useRef<number | null>(null);
  const lastCorruptionResyncRef = useRef<number>(0);
  const isFilteringCorruptedItemsRef = useRef(false);
  const queueUnsubscribeRef = useRef<(() => void) | null>(null);
  const sessionUnsubscribeRef = useRef<(() => void) | null>(null);
  const queueEventSubscribersRef = useRef<Set<(event: SubscriptionQueueEvent) => void>>(new Set());
  const sessionEventSubscribersRef = useRef<Set<(event: SessionEvent) => void>>(new Set());
  // Late-bound by the lifecycle effect below so the event processor (created
  // before lifecycle) can route `SharedPlaylistToggled` broadcasts through
  // the same optimistic setter the local toggle uses.
  const setActiveSessionSharedPlaylistEnabledRef = useRef<((sessionId: string, enabled: boolean) => void) | null>(null);

  // Keep auth ref in sync. The graphql-ws connectionParams are baked in at
  // connect-time, so when the token loads *after* the lifecycle hook has
  // established an unauthenticated connection, the lifecycle effect's
  // `wsAuthToken` dependency below tears the socket down and reconnects with
  // the token in connectionParams.
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
    mountedRef,
    isConnectingRef,
    isReconnectingRef,
    connectionGenerationRef,
    triggerResyncRef,
    lastReceivedSequenceRef,
    lastCorruptionResyncRef,
    isFilteringCorruptedItemsRef,
    queueUnsubscribeRef,
    sessionUnsubscribeRef,
    queueEventSubscribersRef,
    sessionEventSubscribersRef,
    setActiveSessionSharedPlaylistEnabledRef,
  };

  // 1. Event processor: queue state + event handling
  const eventProcessor = useEventProcessor({ refs });

  // Keep queue refs in sync with event processor state
  useEffect(() => {
    queueRef.current = eventProcessor.queue;
  }, [eventProcessor.queue]);
  useEffect(() => {
    currentClimbQueueItemRef.current = eventProcessor.currentClimbQueueItem;
  }, [eventProcessor.currentClimbQueueItem]);

  // 2. Session lifecycle: connect/disconnect, join/leave
  const lifecycle = useSessionLifecycle({
    isAuthLoading,
    handleQueueEvent: eventProcessor.handleQueueEvent,
    handleSessionEvent: eventProcessor.handleSessionEvent,
    setLastReceivedStateHash: eventProcessor.setLastReceivedStateHash,
    refs,
  });

  // Publish the lifecycle's setter via the late-bound ref so the event
  // processor's `SharedPlaylistToggled` handler can call it. `useCallback`
  // identity is stable across renders, but we still mirror it into the ref
  // every render to be safe.
  setActiveSessionSharedPlaylistEnabledRef.current = lifecycle.setActiveSessionSharedPlaylistEnabled;

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

  // 3. Queue storage: in-memory local queue state
  const queueStorage = useQueueStorage({
    activeSession: lifecycle.activeSession,
    setActiveSession: handleQueueStorageSetActiveSession,
    onSessionAutoFinished: lifecycle.setAutoFinishedSummary,
    wsAuthToken,
    isAuthLoading,
  });

  // 4. Queue mutations: GraphQL mutation wrappers
  const mutations = useQueueMutations({
    client: lifecycle.client,
    session: lifecycle.session,
  });

  // 5. Session subscriptions: periodic verification, event subscriptions, corruption checks
  const subscriptions = useSessionSubscriptions({
    session: lifecycle.session,
    queue: eventProcessor.queue,
    currentClimbQueueItem: eventProcessor.currentClimbQueueItem,
    lastReceivedStateHash: eventProcessor.lastReceivedStateHash,
    setQueueState: eventProcessor.setQueueState,
    refs,
  });

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
      setQueue: mutations.setQueue,
      replaceQueueItem: mutations.replaceQueueItem,
      takeControl: mutations.takeControl,
      releaseControl: mutations.releaseControl,
      confirmClimbOnWall: mutations.confirmClimbOnWall,
      setSessionBoardSerial: mutations.setSessionBoardSerial,
      setLocalQueueState: queueStorage.setLocalQueueState,
      clearLocalQueue: queueStorage.clearLocalQueue,
      subscribeToQueueEvents: subscriptions.subscribeToQueueEvents,
      subscribeToSessionEvents: subscriptions.subscribeToSessionEvents,
      triggerResync: subscriptions.triggerResync,
      endSessionWithSummary: lifecycle.endSessionWithSummary,
      dismissSessionSummary: lifecycle.dismissSessionSummary,
      setAutoFinishedSummary: lifecycle.setAutoFinishedSummary,
      setActiveSessionSharedPlaylistEnabled: lifecycle.setActiveSessionSharedPlaylistEnabled,
    }),
    [
      lifecycle.activateSession,
      lifecycle.deactivateSession,
      lifecycle.setInitialQueueForSession,
      lifecycle.endSessionWithSummary,
      lifecycle.dismissSessionSummary,
      lifecycle.setAutoFinishedSummary,
      lifecycle.setActiveSessionSharedPlaylistEnabled,
      mutations.addQueueItem,
      mutations.removeQueueItem,
      mutations.setCurrentClimb,
      mutations.mirrorCurrentClimb,
      mutations.setQueue,
      mutations.replaceQueueItem,
      mutations.takeControl,
      mutations.releaseControl,
      mutations.confirmClimbOnWall,
      mutations.setSessionBoardSerial,
      queueStorage.setLocalQueueState,
      queueStorage.clearLocalQueue,
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
      // Backend-resolved participantId from join — server uses this identity
      // when broadcasting DriverChanged, so driver derivation compares against it.
      participantId: lifecycle.session?.participantId ?? null,
      isLeader: lifecycle.session?.isLeader ?? false,
      driverParticipantId: lifecycle.session?.driverParticipantId ?? null,
      users: lifecycle.session?.users ?? [],
      currentClimbQueueItem: eventProcessor.currentClimbQueueItem,
      queue: eventProcessor.queue,
      localQueue: queueStorage.localQueue,
      localCurrentClimbQueueItem: queueStorage.localCurrentClimbQueueItem,
      localBoardPath: queueStorage.localBoardPath,
      localBoardDetails: queueStorage.localBoardDetails,
      isLocalQueueLoaded: queueStorage.isLocalQueueLoaded,
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
      eventProcessor.currentClimbQueueItem,
      eventProcessor.queue,
      queueStorage.localQueue,
      queueStorage.localCurrentClimbQueueItem,
      queueStorage.localBoardPath,
      queueStorage.localBoardDetails,
      queueStorage.isLocalQueueLoaded,
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
