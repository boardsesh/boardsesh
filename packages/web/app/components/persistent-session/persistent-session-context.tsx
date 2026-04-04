'use client';

import React, { createContext, useContext, useCallback, useMemo, useRef, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../queue-control/types';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { usePartyProfile } from '../party-manager/party-profile-context';
import { isBoardRoutePath } from '@/app/lib/board-route-paths';

import type { PersistentSessionContextType, Session, ActiveSessionInfo, SharedRefs } from './types';
import { useEventProcessor } from './hooks/use-event-processor';
import { useQueueStorage } from './hooks/use-queue-storage';
import { useQueueMutations } from './hooks/use-queue-mutations';
import { useSessionSubscriptions } from './hooks/use-session-subscriptions';
import { useSessionLifecycle } from './hooks/use-session-lifecycle';

// Re-export types for backwards compatibility
export type { PersistentSessionContextType, Session, ActiveSessionInfo } from './types';

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
  const saveQueueTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueEventSubscribersRef = useRef<Set<(event: SubscriptionQueueEvent) => void>>(new Set());
  const sessionEventSubscribersRef = useRef<Set<(event: SessionEvent) => void>>(new Set());

  // Keep auth/profile refs in sync
  useEffect(() => { wsAuthTokenRef.current = wsAuthToken; }, [wsAuthToken]);
  useEffect(() => { usernameRef.current = username; }, [username]);
  useEffect(() => { avatarUrlRef.current = avatarUrl; }, [avatarUrl]);

  // Stable no-op: session is managed internally by lifecycle hook.
  // MUST be useCallback to avoid recreating on every render, which would
  // destabilize the lifecycle effect's dependency array and cause infinite reconnects.
  const noopSetSession = useCallback(() => {}, []);

  const refs: SharedRefs = {
    offlineBufferRef, wsAuthTokenRef, usernameRef, avatarUrlRef,
    sessionRef, activeSessionRef,
    queueRef, currentClimbQueueItemRef,
    mountedRef, isConnectingRef, isReconnectingRef,
    connectionGenerationRef, triggerResyncRef, lastReceivedSequenceRef,
    lastCorruptionResyncRef, isFilteringCorruptedItemsRef,
    queueUnsubscribeRef, sessionUnsubscribeRef, saveQueueTimeoutRef,
    queueEventSubscribersRef, sessionEventSubscribersRef,
  };

  // 1. Event processor: queue state + event handling
  const eventProcessor = useEventProcessor({ refs });

  // Keep queue refs in sync with event processor state
  useEffect(() => { queueRef.current = eventProcessor.queue; }, [eventProcessor.queue]);
  useEffect(() => { currentClimbQueueItemRef.current = eventProcessor.currentClimbQueueItem; }, [eventProcessor.currentClimbQueueItem]);

  // 2. Session lifecycle: connect/disconnect, join/leave
  const lifecycle = useSessionLifecycle({
    isAuthLoading,
    handleQueueEvent: eventProcessor.handleQueueEvent,
    handleSessionEvent: eventProcessor.handleSessionEvent,
    setSession: noopSetSession, // Session is managed internally by lifecycle
    refs,
  });

  // 3. Queue storage: IndexedDB persistence for local queue
  const queueStorage = useQueueStorage({
    activeSession: lifecycle.activeSession,
    setActiveSession: (val) => {
      // The queue storage restore needs to activate sessions it finds in IndexedDB
      if (typeof val === 'function') return;
      if (val) lifecycle.activateSession(val);
    },
  });

  // 4. Queue mutations: GraphQL mutation wrappers
  const mutations = useQueueMutations({
    client: lifecycle.client,
    session: lifecycle.session,
  });

  // 5. Session subscriptions: periodic verification, event subscriptions, corruption checks
  const subscriptions = useSessionSubscriptions({
    session: lifecycle.session,
    activeSession: lifecycle.activeSession,
    queue: eventProcessor.queue,
    currentClimbQueueItem: eventProcessor.currentClimbQueueItem,
    lastReceivedStateHash: eventProcessor.lastReceivedStateHash,
    liveSessionStats: eventProcessor.liveSessionStats,
    setQueueState: eventProcessor.setQueueState,
    setLiveSessionStats: eventProcessor.setLiveSessionStats,
    refs,
  });

  const value = useMemo<PersistentSessionContextType>(
    () => ({
      activeSession: lifecycle.activeSession,
      session: lifecycle.session,
      isConnecting: lifecycle.isConnecting,
      hasConnected: lifecycle.hasConnected,
      error: lifecycle.error,
      clientId: lifecycle.session?.clientId ?? null,
      isLeader: lifecycle.session?.isLeader ?? false,
      users: lifecycle.session?.users ?? [],
      currentClimbQueueItem: eventProcessor.currentClimbQueueItem,
      queue: eventProcessor.queue,
      localQueue: queueStorage.localQueue,
      localCurrentClimbQueueItem: queueStorage.localCurrentClimbQueueItem,
      localBoardPath: queueStorage.localBoardPath,
      localBoardDetails: queueStorage.localBoardDetails,
      isLocalQueueLoaded: queueStorage.isLocalQueueLoaded,
      setLocalQueueState: queueStorage.setLocalQueueState,
      clearLocalQueue: queueStorage.clearLocalQueue,
      loadStoredQueue: queueStorage.loadStoredQueue,
      activateSession: lifecycle.activateSession,
      deactivateSession: lifecycle.deactivateSession,
      setInitialQueueForSession: lifecycle.setInitialQueueForSession,
      addQueueItem: mutations.addQueueItem,
      removeQueueItem: mutations.removeQueueItem,
      setCurrentClimb: mutations.setCurrentClimb,
      mirrorCurrentClimb: mutations.mirrorCurrentClimb,
      setQueue: mutations.setQueue,
      offlineBufferRef,
      lastReceivedSequenceRef,
      subscribeToQueueEvents: subscriptions.subscribeToQueueEvents,
      subscribeToSessionEvents: subscriptions.subscribeToSessionEvents,
      triggerResync: subscriptions.triggerResync,
      endSessionWithSummary: lifecycle.endSessionWithSummary,
      liveSessionStats: eventProcessor.liveSessionStats,
      sessionSummary: lifecycle.sessionSummary,
      dismissSessionSummary: lifecycle.dismissSessionSummary,
    }),
    [
      lifecycle.activeSession, lifecycle.session, lifecycle.isConnecting,
      lifecycle.hasConnected, lifecycle.error, lifecycle.activateSession,
      lifecycle.deactivateSession, lifecycle.setInitialQueueForSession,
      lifecycle.endSessionWithSummary, lifecycle.sessionSummary, lifecycle.dismissSessionSummary,
      eventProcessor.currentClimbQueueItem, eventProcessor.queue, eventProcessor.liveSessionStats,
      queueStorage.localQueue, queueStorage.localCurrentClimbQueueItem,
      queueStorage.localBoardPath, queueStorage.localBoardDetails,
      queueStorage.isLocalQueueLoaded, queueStorage.setLocalQueueState,
      queueStorage.clearLocalQueue, queueStorage.loadStoredQueue,
      mutations.addQueueItem, mutations.removeQueueItem, mutations.setCurrentClimb,
      mutations.mirrorCurrentClimb, mutations.setQueue,
      subscriptions.subscribeToQueueEvents, subscriptions.subscribeToSessionEvents,
      subscriptions.triggerResync,
    ],
  );

  return (
    <PersistentSessionContext.Provider value={value}>
      {children}
    </PersistentSessionContext.Provider>
  );
};

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
