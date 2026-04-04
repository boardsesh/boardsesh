'use client';

import React, { useState, useContext, createContext, useCallback, useMemo, useRef, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { useQueueReducer } from '../queue-control/reducer';
import { useQueueDataFetching } from '../queue-control/hooks/use-queue-data-fetching';
import { ClimbQueueItem, UserName, QueueItemUser } from '../queue-control/types';
import { urlParamsToSearchParams, searchParamsToUrlParams } from '@/app/lib/url-utils';
import { Climb, SearchRequestPagination } from '@/app/lib/types';
import { usePartyProfile } from '../party-manager/party-profile-context';
import { useWebSocketConnection } from '../connection-manager/websocket-connection-provider';
import { FavoritesProvider } from '../climb-actions/favorites-batch-context';
import { PlaylistsProvider } from '../climb-actions/playlists-batch-context';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import { SUGGESTIONS_THRESHOLD } from '../board-page/constants';
import { useSnackbar } from '../providers/snackbar-provider';
import SessionSummaryDialog from '../session-summary/session-summary-dialog';

import { useSessionIdManagement } from './hooks/use-session-id-management';
import { useQueueRestoration } from './hooks/use-queue-restoration';
import { useQueueStorageSync } from './hooks/use-queue-storage-sync';
import { useQueueEventSubscription } from './hooks/use-queue-event-subscription';
import { usePendingUpdateCleanup } from './hooks/use-pending-update-cleanup';
import { useMutationGuard } from './hooks/use-mutation-guard';
import { useOfflineQueueBuffer } from './hooks/use-offline-queue-buffer';
import { useOfflineReconciliation } from './hooks/use-offline-reconciliation';
import type { GraphQLQueueContextType, GraphQLQueueContextProps } from './types';

// Re-export types so direct importers still work
export type { GraphQLQueueContextType } from './types';

const createClimbQueueItem = (
  climb: Climb,
  addedBy: UserName,
  addedByUser?: QueueItemUser,
  suggested?: boolean,
): ClimbQueueItem => ({
  climb,
  addedBy,
  addedByUser,
  uuid: uuidv4(),
  suggested: !!suggested,
});

export const QueueContext = createContext<GraphQLQueueContextType | undefined>(undefined);

export const GraphQLQueueProvider = ({ parsedParams, boardDetails, children, baseBoardPath: propsBaseBoardPath }: GraphQLQueueContextProps) => {
  const searchParamsHook = useSearchParams();
  const initialSearchParams = urlParamsToSearchParams(searchParamsHook);
  const [state, dispatch] = useQueueReducer(initialSearchParams);
  const [countSearchParams, setCountSearchParams] = useState<SearchRequestPagination>(initialSearchParams);

  const isOffBoardMode = propsBaseBoardPath !== undefined;
  const correlationCounterRef = useRef(0);
  const { showMessage } = useSnackbar();

  const { profile, username, avatarUrl } = usePartyProfile();
  const { state: connectionState } = useWebSocketConnection();

  // --- Session ID management ---
  const {
    sessionId, baseBoardPath, isPersistentSessionActive, persistentSession,
    backendUrl, searchParams, pathname,
    startSession, joinSession, endSession, sessionSummary, dismissSessionSummary,
  } = useSessionIdManagement({
    isOffBoardMode,
    propsBaseBoardPath,
    currentQueue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
  });

  // --- Queue restoration ---
  const { hasRestored } = useQueueRestoration({
    isPersistentSessionActive,
    sessionId,
    baseBoardPath,
    dispatch,
    persistentSession,
  });

  // --- Session & connection derived state ---
  const clientId = isPersistentSessionActive ? persistentSession.clientId : null;
  const isLeader = isPersistentSessionActive ? persistentSession.isLeader : false;
  const hasConnected = isPersistentSessionActive ? persistentSession.hasConnected : false;
  const users = useMemo(
    () => (isPersistentSessionActive ? persistentSession.users : []),
    [isPersistentSessionActive, persistentSession.users],
  );
  const connectionError = isPersistentSessionActive ? persistentSession.error : null;
  const isSessionActive = !!sessionId && hasConnected;
  const isSessionReady = isSessionActive && connectionState === 'connected';

  // --- Mutation guard ---
  const { viewOnlyMode, canMutate, guardMutation, isDisconnected } = useMutationGuard({
    sessionId,
    backendUrl,
    hasConnected,
    connectionState,
    isSessionActive,
    isSessionReady,
  });

  // --- Offline queue buffer (tracks additions made while offline in party mode) ---
  const rawOfflineBuffer = useOfflineQueueBuffer();

  // Wrap the buffer to also sync to the persistent session's offlineBufferRef
  // so the event processor can merge during FullSync
  const offlineBuffer = useMemo(() => ({
    ...rawOfflineBuffer,
    bufferAddition: (item: ClimbQueueItem) => {
      rawOfflineBuffer.bufferAddition(item);
      if (isPersistentSessionActive) {
        persistentSession.offlineBufferRef.current = rawOfflineBuffer.getBufferedAdditions();
      }
    },
    clearBuffer: () => {
      rawOfflineBuffer.clearBuffer();
      if (isPersistentSessionActive) {
        persistentSession.offlineBufferRef.current = [];
      }
    },
  }), [rawOfflineBuffer, isPersistentSessionActive, persistentSession]);

  // Warn user when offline buffer is full
  useEffect(() => {
    if (rawOfflineBuffer.isBufferFull) {
      showMessage("You've hit the offline queue limit. Reconnect to sync your climbs.", 'warning');
    }
  }, [rawOfflineBuffer.isBufferFull, showMessage]);

  // --- Offline reconciliation (push buffered additions on reconnect) ---
  useOfflineReconciliation({
    offlineBuffer,
    isDisconnected,
    isPersistentSessionActive,
    hasConnected,
    users,
    lastReceivedSequenceRef: isPersistentSessionActive ? persistentSession.lastReceivedSequenceRef : { current: null },
    persistentSession,
    currentQueue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
  });

  // --- Queue storage sync ---
  useQueueStorageSync({
    hasRestored,
    isPersistentSessionActive,
    sessionId,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    baseBoardPath,
    boardDetails,
    isDisconnected,
    persistentSession,
  });

  // --- Queue event subscription ---
  useQueueEventSubscription({
    isPersistentSessionActive,
    dispatch,
    persistentSession,
    needsResync: state.needsResync,
  });

  // --- Pending update cleanup ---
  usePendingUpdateCleanup({
    isPersistentSessionActive,
    pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates,
    dispatch,
  });

  // --- Current user info ---
  const currentUserInfo: QueueItemUser | undefined = useMemo(() => {
    if (!profile?.id) return undefined;
    return { id: profile.id, username: username || '', avatarUrl };
  }, [profile?.id, username, avatarUrl]);

  // --- Data fetching ---
  const {
    climbSearchResults, suggestedClimbs, totalSearchResultCount, hasMoreResults,
    isFetchingClimbs, isFetchingNextPage, fetchMoreClimbs, climbUuids,
  } = useQueueDataFetching({
    searchParams: state.climbSearchParams,
    countSearchParams,
    queue: state.queue,
    parsedParams,
    hasDoneFirstFetch: state.hasDoneFirstFetch,
    setHasDoneFirstFetch: () => dispatch({ type: 'SET_FIRST_FETCH', payload: true }),
  });

  const { favoritesProviderProps, playlistsProviderProps } = useClimbActionsData({
    boardName: parsedParams.board_name,
    layoutId: boardDetails.layout_id,
    angle: parsedParams.angle,
    climbUuids,
  });

  // --- Proactive suggestion fetching ---
  const proactiveFetchState = useRef({
    lastSuggestedCount: suggestedClimbs.length,
    lastQueueLength: state.queue.length,
    hasFetchedForCurrentLowState: false,
  });

  useEffect(() => {
    const prev = proactiveFetchState.current;
    if (
      suggestedClimbs.length > prev.lastSuggestedCount ||
      state.queue.length < prev.lastQueueLength ||
      !hasMoreResults
    ) {
      prev.hasFetchedForCurrentLowState = false;
    }
    prev.lastSuggestedCount = suggestedClimbs.length;
    prev.lastQueueLength = state.queue.length;

    if (isFetchingNextPage || !hasMoreResults) return;
    if (
      suggestedClimbs.length < SUGGESTIONS_THRESHOLD &&
      state.hasDoneFirstFetch &&
      !prev.hasFetchedForCurrentLowState
    ) {
      prev.hasFetchedForCurrentLowState = true;
      fetchMoreClimbs();
    }
  }, [suggestedClimbs.length, state.queue.length, hasMoreResults, isFetchingNextPage, fetchMoreClimbs, state.hasDoneFirstFetch]);

  // --- Context value ---
  const contextValue: GraphQLQueueContextType = useMemo(
    () => ({
      queue: state.queue,
      currentClimbQueueItem: state.currentClimbQueueItem,
      currentClimb: state.currentClimbQueueItem?.climb || null,
      climbSearchParams: state.climbSearchParams,
      climbSearchResults, suggestedClimbs, totalSearchResultCount, hasMoreResults,
      isFetchingClimbs, isFetchingNextPage,
      hasDoneFirstFetch: state.hasDoneFirstFetch,
      viewOnlyMode, parsedParams,
      isSessionActive, sessionId, startSession, joinSession, endSession,
      sessionSummary, dismissSessionSummary,
      sessionGoal: isPersistentSessionActive ? (persistentSession.session?.goal ?? null) : null,
      connectionState, canMutate, isDisconnected,
      users, clientId, isLeader,
      isBackendMode: !!backendUrl,
      hasConnected, connectionError,
      disconnect: persistentSession.deactivateSession,

      addToQueue: (climb: Climb) => {
        if (guardMutation()) return;
        const newItem = createClimbQueueItem(climb, clientId, currentUserInfo);
        dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: newItem } });
        if (isDisconnected && isPersistentSessionActive) {
          offlineBuffer.bufferAddition(newItem);
        } else if (hasConnected && isPersistentSessionActive) {
          persistentSession.addQueueItem(newItem).catch((error: unknown) => console.error('Failed to add queue item:', error));
        }
      },

      removeFromQueue: (item: ClimbQueueItem) => {
        if (guardMutation()) return;
        dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: item.uuid } });
        if (!isDisconnected && hasConnected && isPersistentSessionActive) {
          persistentSession.removeQueueItem(item.uuid).catch((error: unknown) => console.error('Failed to remove queue item:', error));
        }
      },

      setCurrentClimb: async (climb: Climb) => {
        if (guardMutation()) return;
        const newItem = createClimbQueueItem(climb, clientId, currentUserInfo);
        dispatch({ type: 'SET_CURRENT_CLIMB', payload: newItem });
        if (isDisconnected && isPersistentSessionActive) {
          offlineBuffer.bufferAddition(newItem);
        } else if (hasConnected && isPersistentSessionActive) {
          const previousQueue = [...state.queue];
          const previousCurrentClimb = state.currentClimbQueueItem;
          const currentIndex = state.currentClimbQueueItem
            ? state.queue.findIndex((queueItem: ClimbQueueItem) => queueItem.uuid === state.currentClimbQueueItem?.uuid)
            : -1;
          const position = currentIndex === -1 ? undefined : currentIndex + 1;
          try {
            await persistentSession.addQueueItem(newItem, position);
            await persistentSession.setCurrentClimb(newItem, false);
          } catch (error: unknown) {
            console.error('Failed to set current climb, rolling back:', error);
            dispatch({ type: 'UPDATE_QUEUE', payload: { queue: previousQueue, currentClimbQueueItem: previousCurrentClimb } });
          }
        }
      },

      setQueue: (queue: ClimbQueueItem[]) => {
        if (guardMutation()) return;
        dispatch({ type: 'UPDATE_QUEUE', payload: { queue, currentClimbQueueItem: state.currentClimbQueueItem } });
        if (!isDisconnected && hasConnected && isPersistentSessionActive) {
          persistentSession.setQueue(queue, state.currentClimbQueueItem).catch((error: unknown) => console.error('Failed to set queue:', error));
        }
      },

      setCurrentClimbQueueItem: (item: ClimbQueueItem) => {
        if (guardMutation()) return;
        const correlationId = clientId ? `${clientId}-${++correlationCounterRef.current}` : undefined;
        dispatch({ type: 'DELTA_UPDATE_CURRENT_CLIMB', payload: { item, shouldAddToQueue: item.suggested, correlationId } });
        if (!isDisconnected && hasConnected && isPersistentSessionActive) {
          persistentSession.setCurrentClimb(item, item.suggested, correlationId).catch((error: unknown) => {
            console.error('Failed to set current climb:', error);
            if (correlationId) dispatch({ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId } });
          });
        }
      },

      setClimbSearchParams: (params: SearchRequestPagination) => {
        dispatch({ type: 'SET_CLIMB_SEARCH_PARAMS', payload: params });
        if (!isOffBoardMode) {
          const urlParams = searchParamsToUrlParams(params);
          const queryString = urlParams.toString();
          const newUrl = queryString ? `${pathname}?${queryString}` : pathname;
          // Use history.replaceState instead of router.replace to update the URL
          // without triggering a server-side re-render. After the initial page load,
          // climb data is fetched client-side via TanStack Query, so re-running
          // the server component on every filter change is wasted work.
          window.history.replaceState(window.history.state, '', newUrl);
        }
      },

      setCountSearchParams: (params: SearchRequestPagination) => {
        setCountSearchParams(params);
      },

      mirrorClimb: () => {
        if (guardMutation()) return;
        if (!state.currentClimbQueueItem?.climb) return;
        const newMirroredState = !state.currentClimbQueueItem.climb?.mirrored;
        dispatch({ type: 'DELTA_MIRROR_CURRENT_CLIMB', payload: { mirrored: newMirroredState } });
        if (!isDisconnected && hasConnected && isPersistentSessionActive) {
          persistentSession.mirrorCurrentClimb(newMirroredState).catch((error: unknown) => console.error('Failed to mirror climb:', error));
        }
      },

      fetchMoreClimbs,

      getNextClimbQueueItem: () => {
        const queueItemIndex = state.queue.findIndex((queueItem: ClimbQueueItem) => queueItem.uuid === state.currentClimbQueueItem?.uuid);
        if (
          (state.queue.length === 0 || state.queue.length <= queueItemIndex + 1) &&
          climbSearchResults && climbSearchResults.length > 0
        ) {
          const nextClimb = suggestedClimbs.find(
            (climb: Climb) => !state.queue.some((qItem: ClimbQueueItem) => qItem.climb?.uuid === climb.uuid),
          );
          return nextClimb ? createClimbQueueItem(nextClimb, clientId, currentUserInfo, true) : null;
        }
        return queueItemIndex >= state.queue.length - 1 ? null : state.queue[queueItemIndex + 1];
      },

      getPreviousClimbQueueItem: () => {
        const queueItemIndex = state.queue.findIndex((queueItem: ClimbQueueItem) => queueItem.uuid === state.currentClimbQueueItem?.uuid);
        return queueItemIndex > 0 ? state.queue[queueItemIndex - 1] : null;
      },
    }),
    [
      state, climbSearchResults, suggestedClimbs, totalSearchResultCount, hasMoreResults,
      isFetchingClimbs, isFetchingNextPage, viewOnlyMode, parsedParams,
      clientId, isLeader, users, hasConnected, connectionError, backendUrl,
      persistentSession, isPersistentSessionActive, dispatch, pathname,
      fetchMoreClimbs, currentUserInfo, isSessionActive, sessionId, setCountSearchParams,
      startSession, joinSession, endSession, sessionSummary, dismissSessionSummary,
      isOffBoardMode, connectionState, canMutate, guardMutation, searchParams, isDisconnected,
      offlineBuffer,
    ],
  );

  return (
    <QueueContext.Provider value={contextValue}>
      <FavoritesProvider {...favoritesProviderProps}>
        <PlaylistsProvider {...playlistsProviderProps}>
          {children}
        </PlaylistsProvider>
      </FavoritesProvider>
      <SessionSummaryDialog summary={sessionSummary} onDismiss={dismissSessionSummary} />
    </QueueContext.Provider>
  );
};

export const useGraphQLQueueContext = (): GraphQLQueueContextType => {
  const context = useContext(QueueContext);
  if (!context) {
    throw new Error('useGraphQLQueueContext must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useOptionalQueueContext = (): GraphQLQueueContextType | null => {
  return useContext(QueueContext) ?? null;
};

// Re-export the hook with the standard name for easier migration
export { useGraphQLQueueContext as useQueueContext };
