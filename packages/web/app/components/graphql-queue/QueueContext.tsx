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
import { trackQueueOperation, trackQueueOperationError, type QueueOperationMode } from '@/app/lib/queue-metrics';

import { useSessionIdManagement } from './hooks/use-session-id-management';
import { useQueueRestoration } from './hooks/use-queue-restoration';
import { useQueueEventSubscription } from './hooks/use-queue-event-subscription';
import { usePendingUpdateCleanup } from './hooks/use-pending-update-cleanup';
import { useMutationGuard } from './hooks/use-mutation-guard';
import { useOfflineQueueBuffer } from './hooks/use-offline-queue-buffer';
import { useOfflineReconciliation } from './hooks/use-offline-reconciliation';
import { useQueueAddValidator } from '../board-lock/use-queue-add-validator';
import { useQueueAddConfirm, type AddOutcome } from '../queue-control/queue-add-confirm-context';
import { boardConfigToBaseBoardPath } from '@/app/lib/board-config';
import { useRouter } from 'next/navigation';
import type { BoardConfig } from '@boardsesh/shared-schema';
import type {
  GraphQLQueueContextType,
  GraphQLQueueActionsType,
  GraphQLQueueDataType,
  GraphQLQueueContextProps,
  CurrentClimbDataType,
  QueueListDataType,
  SearchDataType,
  SessionDataType,
} from './types';

// Re-export types so direct importers still work
export type { GraphQLQueueContextType, GraphQLQueueActionsType, GraphQLQueueDataType } from './types';
export type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from './types';

/**
 * Construct a queue item. When `boardConfig` is supplied, it's stamped on the
 * item and its `boardName`/`layoutId` are also mirrored onto `climb` so
 * downstream UI never has to fall back to the context to know a climb's
 * board. `boardId` (named-board UUID) is only stamped when paired with a
 * `boardConfig` — see the co-presence invariant in the plan.
 */
const createClimbQueueItem = (
  climb: Climb,
  addedBy: UserName,
  addedByUser?: QueueItemUser,
  suggested?: boolean,
  boardConfig?: BoardConfig | null,
  boardId?: string | null,
): ClimbQueueItem => ({
  climb: boardConfig
    ? {
        ...climb,
        boardType: climb.boardType ?? boardConfig.boardName,
        layoutId: climb.layoutId ?? boardConfig.layoutId,
      }
    : climb,
  addedBy,
  addedByUser,
  uuid: uuidv4(),
  suggested: !!suggested,
  boardConfig: boardConfig ?? null,
  boardId: boardConfig ? (boardId ?? null) : null,
});

// Split contexts: actions (stable) vs data (changes frequently)
export const QueueActionsContext = createContext<GraphQLQueueActionsType | undefined>(undefined);
export const QueueDataContext = createContext<GraphQLQueueDataType | undefined>(undefined);
// Combined context for backward compatibility
export const QueueContext = createContext<GraphQLQueueContextType | undefined>(undefined);

// Fine-grained contexts for targeted subscriptions (reduces re-render cascade)
export const CurrentClimbContext = createContext<CurrentClimbDataType | undefined>(undefined);
// Ultra-narrow context: only the UUID string of the current climb.
// Components that only need to know *which* climb is current (not the full object)
// can subscribe here and avoid re-renders when unrelated fields change.
export const CurrentClimbUuidContext = createContext<string | null>(null);
export const QueueListContext = createContext<QueueListDataType | undefined>(undefined);
export const SearchContext = createContext<SearchDataType | undefined>(undefined);
export const SessionContext = createContext<SessionDataType | undefined>(undefined);

export const GraphQLQueueProvider = ({
  parsedParams,
  boardDetails,
  children,
  baseBoardPath: propsBaseBoardPath,
  boardId: propsBoardId,
}: GraphQLQueueContextProps) => {
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
    sessionId,
    baseBoardPath,
    isPersistentSessionActive,
    persistentSession,
    backendUrl,
    searchParams,
    pathname,
    startSession,
    joinSession,
    endSession,
    sessionSummary,
    dismissSessionSummary,
  } = useSessionIdManagement({
    isOffBoardMode,
    propsBaseBoardPath,
    currentQueue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
  });

  // Board config for the current route — passed into hooks so ingress
  // normalization can backfill legacy queue items that lack `boardConfig`.
  const routeBoardConfig: BoardConfig = useMemo(() => ({
    boardName: boardDetails.board_name,
    layoutId: boardDetails.layout_id,
    sizeId: boardDetails.size_id,
    setIds: boardDetails.set_ids,
    angle: parsedParams.angle,
  }), [boardDetails.board_name, boardDetails.layout_id, boardDetails.size_id, boardDetails.set_ids, parsedParams.angle]);

  // --- Queue restoration (from in-memory bridge state or party session) ---
  useQueueRestoration({
    isPersistentSessionActive,
    sessionId,
    baseBoardPath,
    dispatch,
    persistentSession,
    fallbackBoardConfig: routeBoardConfig,
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
  const offlineBuffer = useMemo(
    () => ({
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
    }),
    [rawOfflineBuffer, isPersistentSessionActive, persistentSession],
  );

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

  // --- Queue event subscription ---
  useQueueEventSubscription({
    isPersistentSessionActive,
    dispatch,
    persistentSession,
    needsResync: state.needsResync,
    fallbackBoardConfig: routeBoardConfig,
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
    climbSearchResults,
    suggestedClimbs,
    totalSearchResultCount,
    hasMoreResults,
    isFetchingClimbs,
    isFetchingNextPage,
    fetchMoreClimbs,
    climbUuids,
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
  }, [
    suggestedClimbs.length,
    state.queue.length,
    hasMoreResults,
    isFetchingNextPage,
    fetchMoreClimbs,
    state.hasDoneFirstFetch,
  ]);

  // --- Queue-add compatibility validator ---
  const validateQueueAdd = useQueueAddValidator();

  // --- Confirmation gate for cross-board / cross-size adds ---
  const confirmApi = useQueueAddConfirm();
  const router = useRouter();

  // --- Ref holding latest values so action callbacks can be stable ---
  const latestRef = useRef({
    state,
    dispatch,
    isPersistentSessionActive,
    persistentSession,
    clientId,
    currentUserInfo,
    isDisconnected,
    hasConnected,
    offlineBuffer,
    guardMutation,
    isOffBoardMode,
    pathname,
    climbSearchResults,
    suggestedClimbs,
    setCountSearchParams,
    correlationCounterRef,
    startSession,
    joinSession,
    endSession,
    dismissSessionSummary,
    fetchMoreClimbs,
    validateQueueAdd,
    confirmApi,
    router,
    currentBoardConfig: routeBoardConfig,
    boardId: propsBoardId ?? null,
  });
  // Sync ref every render (synchronous — safe for refs)
  latestRef.current = {
    state,
    dispatch,
    isPersistentSessionActive,
    persistentSession,
    clientId,
    currentUserInfo,
    isDisconnected,
    hasConnected,
    offlineBuffer,
    guardMutation,
    isOffBoardMode,
    pathname,
    climbSearchResults,
    suggestedClimbs,
    setCountSearchParams,
    correlationCounterRef,
    startSession,
    joinSession,
    endSession,
    dismissSessionSummary,
    fetchMoreClimbs,
    validateQueueAdd,
    confirmApi,
    router,
    currentBoardConfig: routeBoardConfig,
    boardId: propsBoardId ?? null,
  };

  // --- Stable action callbacks (read from latestRef, never recreated) ---
  const addToQueue = useCallback((climb: Climb) => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return;
    if (!r.validateQueueAdd(climb)) return;
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';
    const newItem = createClimbQueueItem(
      climb,
      r.clientId,
      r.currentUserInfo,
      false,
      r.currentBoardConfig,
      r.boardId,
    );

    // Fire-and-forget async gate: may show a confirmation dialog for
    // cross-board / larger-size adds. No dialog when the queue is empty
    // or the incoming config is already accepted.
    const commitAdd = () => {
      r.dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: newItem } });
      if (r.isDisconnected && r.isPersistentSessionActive) {
        r.offlineBuffer.bufferAddition(newItem);
        trackQueueOperation('addToQueue', performance.now() - startTime, mode);
      } else if (r.hasConnected && r.isPersistentSessionActive) {
        r.persistentSession
          .addQueueItem(newItem)
          .then(() => trackQueueOperation('addToQueue', performance.now() - startTime, mode))
          .catch((error: unknown) => {
            console.error('Failed to add queue item:', error);
            trackQueueOperationError('addToQueue', mode);
          });
      } else {
        trackQueueOperation('addToQueue', performance.now() - startTime, mode);
      }
    };

    (async () => {
      let outcome: AddOutcome = 'allow';
      if (r.confirmApi) {
        outcome = await r.confirmApi.gate(r.currentBoardConfig, r.state.queue);
      }
      if (outcome === 'cancel') return;
      if (outcome === 'switch') {
        // Replace the queue with just this item and navigate to the target board's route.
        r.dispatch({
          type: 'UPDATE_QUEUE',
          payload: { queue: [newItem], currentClimbQueueItem: newItem },
        });
        trackQueueOperation('addToQueue', performance.now() - startTime, mode);
        try {
          r.router.push(
            `${boardConfigToBaseBoardPath(r.currentBoardConfig)}/${r.currentBoardConfig.angle}/list`,
          );
        } catch {
          // Router not available (e.g. in tests) — navigation is best-effort.
        }
        return;
      }
      commitAdd();
    })();
  }, []);

  const removeFromQueue = useCallback((item: ClimbQueueItem) => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return;
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';
    r.dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: item.uuid } });
    if (!r.isDisconnected && r.hasConnected && r.isPersistentSessionActive) {
      r.persistentSession
        .removeQueueItem(item.uuid)
        .then(() => trackQueueOperation('removeFromQueue', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to remove queue item:', error);
          trackQueueOperationError('removeFromQueue', mode);
        });
    } else {
      trackQueueOperation('removeFromQueue', performance.now() - startTime, mode);
    }
  }, []);

  // Resolves to the freshly-created ClimbQueueItem so callers (notably the
  // create form) can capture its uuid and later call replaceQueueItem on
  // subsequent edits. Resolves to null when validation fails or the mutation
  // is guarded.
  const setCurrentClimb = useCallback(async (climb: Climb): Promise<ClimbQueueItem | null> => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return null;
    if (!r.validateQueueAdd(climb)) return null;
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';

    // Gate on cross-board / larger-size before dispatching anything so the
    // optimistic update doesn't flash when the user will ultimately cancel.
    let outcome: AddOutcome = 'allow';
    if (r.confirmApi) {
      outcome = await r.confirmApi.gate(r.currentBoardConfig, r.state.queue);
    }
    if (outcome === 'cancel') return null;

    const newItem = createClimbQueueItem(
      climb,
      r.clientId,
      r.currentUserInfo,
      false,
      r.currentBoardConfig,
      r.boardId,
    );
    const correlationId = r.clientId ? `${r.clientId}-${++r.correlationCounterRef.current}` : undefined;

    if (outcome === 'switch') {
      r.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [newItem], currentClimbQueueItem: newItem },
      });
      trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
      try {
        r.router.push(
          `${boardConfigToBaseBoardPath(r.currentBoardConfig)}/${r.currentBoardConfig.angle}/list`,
        );
      } catch {
        // Router not available — best-effort navigation.
      }
      return newItem;
    }

    r.dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: true, correlationId },
    });
    if (r.isDisconnected && r.isPersistentSessionActive) {
      r.offlineBuffer.bufferAddition(newItem);
      trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
    } else if (r.hasConnected && r.isPersistentSessionActive) {
      const currentIndex = r.state.currentClimbQueueItem
        ? r.state.queue.findIndex((queueItem) => queueItem.uuid === r.state.currentClimbQueueItem?.uuid)
        : -1;
      const position = currentIndex === -1 ? undefined : currentIndex + 1;
      try {
        await r.persistentSession.addQueueItem(newItem, position);
        await r.persistentSession.setCurrentClimb(newItem, false, correlationId);
        trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
      } catch (error: unknown) {
        console.error('Failed to set current climb:', error);
        if (correlationId) r.dispatch({ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId } });
        trackQueueOperationError('setCurrentClimb', mode);
      }
    } else {
      trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
    }
    return newItem;
  }, []);

  // Replace an existing queue item in place with a new climb, preserving the
  // queue-item uuid and the existing addedBy attribution. Used by the create
  // form on subsequent saves so the queue item stays in the same slot instead
  // of piling up duplicates.
  const replaceQueueItem = useCallback((queueItemUuid: string, climb: Climb) => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return;
    if (!r.validateQueueAdd(climb)) return;
    const existing = r.state.queue.find((qItem) => qItem.uuid === queueItemUuid);
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';
    const base = createClimbQueueItem(
      climb,
      r.clientId,
      r.currentUserInfo,
      false,
      r.currentBoardConfig,
      r.boardId,
    );
    const newItem: ClimbQueueItem = {
      ...base,
      uuid: queueItemUuid,
      addedBy: existing?.addedBy ?? base.addedBy,
      addedByUser: existing?.addedByUser ?? base.addedByUser,
      tickedBy: existing?.tickedBy,
    };
    r.dispatch({
      type: 'DELTA_REPLACE_QUEUE_ITEM',
      payload: { uuid: queueItemUuid, item: newItem },
    });
    if (!r.isDisconnected && r.hasConnected && r.isPersistentSessionActive) {
      r.persistentSession
        .replaceQueueItem(queueItemUuid, newItem)
        .then(() => trackQueueOperation('replaceQueueItem', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to replace queue item:', error);
          trackQueueOperationError('replaceQueueItem', mode);
        });
    } else {
      trackQueueOperation('replaceQueueItem', performance.now() - startTime, mode);
    }
  }, []);

  const setQueue = useCallback((queue: ClimbQueueItem[]) => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return;
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';
    r.dispatch({
      type: 'UPDATE_QUEUE',
      payload: { queue, currentClimbQueueItem: r.state.currentClimbQueueItem },
    });
    if (!r.isDisconnected && r.hasConnected && r.isPersistentSessionActive) {
      r.persistentSession
        .setQueue(queue, r.state.currentClimbQueueItem)
        .then(() => trackQueueOperation('setQueue', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to set queue:', error);
          trackQueueOperationError('setQueue', mode);
        });
    } else {
      trackQueueOperation('setQueue', performance.now() - startTime, mode);
    }
  }, []);

  const setCurrentClimbQueueItem = useCallback((item: ClimbQueueItem) => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return;
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';
    const correlationId = r.clientId ? `${r.clientId}-${++r.correlationCounterRef.current}` : undefined;
    r.dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue: item.suggested, correlationId },
    });
    if (!r.isDisconnected && r.hasConnected && r.isPersistentSessionActive) {
      r.persistentSession
        .setCurrentClimb(item, item.suggested, correlationId)
        .then(() => trackQueueOperation('setCurrentClimbQueueItem', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to set current climb:', error);
          if (correlationId) r.dispatch({ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId } });
          trackQueueOperationError('setCurrentClimbQueueItem', mode);
        });
    } else {
      trackQueueOperation('setCurrentClimbQueueItem', performance.now() - startTime, mode);
    }
  }, []);

  const setClimbSearchParams = useCallback((params: SearchRequestPagination) => {
    const r = latestRef.current;
    r.dispatch({ type: 'SET_CLIMB_SEARCH_PARAMS', payload: params });
    if (!r.isOffBoardMode) {
      const urlParams = searchParamsToUrlParams(params);
      const queryString = urlParams.toString();
      const newUrl = queryString ? `${r.pathname}?${queryString}` : r.pathname;
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, []);

  const setCountSearchParamsAction = useCallback((params: SearchRequestPagination) => {
    latestRef.current.setCountSearchParams(params);
  }, []);

  const mirrorClimb = useCallback(() => {
    const startTime = performance.now();
    const r = latestRef.current;
    if (r.guardMutation()) return;
    if (!r.state.currentClimbQueueItem?.climb) return;
    const mode: QueueOperationMode = !r.isPersistentSessionActive
      ? 'local'
      : r.isDisconnected
        ? 'party-offline'
        : 'party';
    const newMirroredState = !r.state.currentClimbQueueItem.climb?.mirrored;
    r.dispatch({ type: 'DELTA_MIRROR_CURRENT_CLIMB', payload: { mirrored: newMirroredState } });
    if (!r.isDisconnected && r.hasConnected && r.isPersistentSessionActive) {
      r.persistentSession
        .mirrorCurrentClimb(newMirroredState)
        .then(() => trackQueueOperation('mirrorClimb', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to mirror climb:', error);
          trackQueueOperationError('mirrorClimb', mode);
        });
    } else {
      trackQueueOperation('mirrorClimb', performance.now() - startTime, mode);
    }
  }, []);

  const stableFetchMoreClimbs = useCallback(() => {
    latestRef.current.fetchMoreClimbs();
  }, []);

  const getNextClimbQueueItem = useCallback(() => {
    const r = latestRef.current;
    const queueItemIndex = r.state.queue.findIndex(
      (queueItem: ClimbQueueItem) => queueItem.uuid === r.state.currentClimbQueueItem?.uuid,
    );
    if (
      (r.state.queue.length === 0 || r.state.queue.length <= queueItemIndex + 1) &&
      r.climbSearchResults &&
      r.climbSearchResults.length > 0
    ) {
      const nextClimb = r.suggestedClimbs.find(
        (climb: Climb) => !r.state.queue.some((qItem: ClimbQueueItem) => qItem.climb?.uuid === climb.uuid),
      );
      return nextClimb ? createClimbQueueItem(nextClimb, r.clientId, r.currentUserInfo, true, r.currentBoardConfig, r.boardId) : null;
    }
    return queueItemIndex >= r.state.queue.length - 1 ? null : r.state.queue[queueItemIndex + 1];
  }, []);

  const getPreviousClimbQueueItem = useCallback(() => {
    const r = latestRef.current;
    const queueItemIndex = r.state.queue.findIndex(
      (queueItem: ClimbQueueItem) => queueItem.uuid === r.state.currentClimbQueueItem?.uuid,
    );
    return queueItemIndex > 0 ? r.state.queue[queueItemIndex - 1] : null;
  }, []);

  // Optimistic dispatch for widget navigation (Next/Previous from Live Activity).
  // The native WebSocket already sent the server mutation, so we only need to
  // update the local reducer state and register the correlationId for echo suppression.
  const dispatchWidgetNavigation = useCallback((item: ClimbQueueItem, correlationId: string) => {
    const r = latestRef.current;
    r.dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue: false, correlationId },
    });
  }, []);

  const stableStartSession = useCallback((options?: { discoverable?: boolean; name?: string; sessionId?: string }) => {
    return latestRef.current.startSession(options);
  }, []);

  const stableJoinSession = useCallback((sessionId: string) => {
    return latestRef.current.joinSession(sessionId);
  }, []);

  const stableEndSession = useCallback(() => {
    latestRef.current.endSession();
  }, []);

  const stableDismissSessionSummary = useCallback(() => {
    latestRef.current.dismissSessionSummary();
  }, []);

  const stableDisconnect = useCallback(() => {
    latestRef.current.persistentSession.deactivateSession();
  }, []);

  // --- Actions context value (stable — callbacks never change) ---
  const actionsValue: GraphQLQueueActionsType = useMemo(
    () => ({
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setQueue,
      setCurrentClimbQueueItem,
      replaceQueueItem,
      setClimbSearchParams,
      setCountSearchParams: setCountSearchParamsAction,
      mirrorClimb,
      fetchMoreClimbs: stableFetchMoreClimbs,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      disconnect: stableDisconnect,
      dispatchWidgetNavigation,
      startSession: stableStartSession,
      joinSession: stableJoinSession,
      endSession: stableEndSession,
      dismissSessionSummary: stableDismissSessionSummary,
    }),
    [
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setQueue,
      setCurrentClimbQueueItem,
      replaceQueueItem,
      setClimbSearchParams,
      setCountSearchParamsAction,
      mirrorClimb,
      stableFetchMoreClimbs,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      dispatchWidgetNavigation,
      stableDisconnect,
      stableStartSession,
      stableJoinSession,
      stableEndSession,
      stableDismissSessionSummary,
    ],
  );

  // --- Data context value (changes when state/data changes) ---
  const dataValue: GraphQLQueueDataType = useMemo(
    () => ({
      queue: state.queue,
      currentClimbQueueItem: state.currentClimbQueueItem,
      currentClimb: state.currentClimbQueueItem?.climb || null,
      climbSearchParams: state.climbSearchParams,
      climbSearchResults,
      suggestedClimbs,
      totalSearchResultCount,
      hasMoreResults,
      isFetchingClimbs,
      isFetchingNextPage,
      hasDoneFirstFetch: state.hasDoneFirstFetch,
      viewOnlyMode,
      parsedParams,
      isSessionActive,
      sessionId,
      sessionSummary,
      sessionGoal: isPersistentSessionActive ? (persistentSession.session?.goal ?? null) : null,
      connectionState,
      canMutate,
      isDisconnected,
      users,
      clientId,
      isLeader,
      isBackendMode: !!backendUrl,
      hasConnected,
      connectionError,
    }),
    [
      state.queue,
      state.currentClimbQueueItem,
      state.climbSearchParams,
      state.hasDoneFirstFetch,
      climbSearchResults,
      suggestedClimbs,
      totalSearchResultCount,
      hasMoreResults,
      isFetchingClimbs,
      isFetchingNextPage,
      viewOnlyMode,
      parsedParams,
      isSessionActive,
      sessionId,
      sessionSummary,
      isPersistentSessionActive,
      persistentSession.session?.goal,
      connectionState,
      canMutate,
      isDisconnected,
      users,
      clientId,
      isLeader,
      backendUrl,
      hasConnected,
      connectionError,
    ],
  );

  // --- Combined context value for backward compatibility ---
  const contextValue: GraphQLQueueContextType = useMemo(
    () => ({ ...dataValue, ...actionsValue }),
    [dataValue, actionsValue],
  );

  // --- Fine-grained context values (each only changes when its specific fields change) ---
  const currentClimbUuid = state.currentClimbQueueItem?.uuid ?? null;

  const currentClimbValue: CurrentClimbDataType = useMemo(
    () => ({
      currentClimbQueueItem: state.currentClimbQueueItem,
      currentClimb: state.currentClimbQueueItem?.climb || null,
    }),
    [state.currentClimbQueueItem],
  );

  const queueListValue: QueueListDataType = useMemo(
    () => ({
      queue: state.queue,
      suggestedClimbs,
    }),
    [state.queue, suggestedClimbs],
  );

  const searchValue: SearchDataType = useMemo(
    () => ({
      climbSearchParams: state.climbSearchParams,
      climbSearchResults,
      totalSearchResultCount,
      hasMoreResults,
      isFetchingClimbs,
      isFetchingNextPage,
      hasDoneFirstFetch: state.hasDoneFirstFetch,
      parsedParams,
    }),
    [
      state.climbSearchParams,
      state.hasDoneFirstFetch,
      climbSearchResults,
      totalSearchResultCount,
      hasMoreResults,
      isFetchingClimbs,
      isFetchingNextPage,
      parsedParams,
    ],
  );

  const sessionValue: SessionDataType = useMemo(
    () => ({
      viewOnlyMode,
      isSessionActive,
      sessionId,
      sessionSummary,
      sessionGoal: isPersistentSessionActive ? (persistentSession.session?.goal ?? null) : null,
      connectionState,
      canMutate,
      isDisconnected,
      users,
      clientId,
      isLeader,
      isBackendMode: !!backendUrl,
      hasConnected,
      connectionError,
    }),
    [
      viewOnlyMode,
      isSessionActive,
      sessionId,
      sessionSummary,
      isPersistentSessionActive,
      persistentSession.session?.goal,
      connectionState,
      canMutate,
      isDisconnected,
      users,
      clientId,
      isLeader,
      backendUrl,
      hasConnected,
      connectionError,
    ],
  );

  return (
    <QueueActionsContext.Provider value={actionsValue}>
      <QueueDataContext.Provider value={dataValue}>
        <QueueContext.Provider value={contextValue}>
          <CurrentClimbContext.Provider value={currentClimbValue}>
            <CurrentClimbUuidContext.Provider value={currentClimbUuid}>
              <QueueListContext.Provider value={queueListValue}>
                <SearchContext.Provider value={searchValue}>
                  <SessionContext.Provider value={sessionValue}>
                    <FavoritesProvider {...favoritesProviderProps}>
                      <PlaylistsProvider {...playlistsProviderProps}>{children}</PlaylistsProvider>
                    </FavoritesProvider>
                    <SessionSummaryDialog summary={sessionSummary} onDismiss={stableDismissSessionSummary} />
                  </SessionContext.Provider>
                </SearchContext.Provider>
              </QueueListContext.Provider>
            </CurrentClimbUuidContext.Provider>
          </CurrentClimbContext.Provider>
        </QueueContext.Provider>
      </QueueDataContext.Provider>
    </QueueActionsContext.Provider>
  );
};

// --- Targeted hooks (prefer these for performance) ---

export const useQueueActions = (): GraphQLQueueActionsType => {
  const context = useContext(QueueActionsContext);
  if (!context) {
    throw new Error('useQueueActions must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useOptionalQueueActions = (): GraphQLQueueActionsType | null => {
  return useContext(QueueActionsContext) ?? null;
};

export const useQueueData = (): GraphQLQueueDataType => {
  const context = useContext(QueueDataContext);
  if (!context) {
    throw new Error('useQueueData must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useOptionalQueueData = (): GraphQLQueueDataType | null => {
  return useContext(QueueDataContext) ?? null;
};

// --- Backward-compatible hooks (subscribe to everything) ---

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

// --- Fine-grained hooks (subscribe to only what you need) ---

export const useCurrentClimb = (): CurrentClimbDataType => {
  const context = useContext(CurrentClimbContext);
  if (!context) {
    throw new Error('useCurrentClimb must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useOptionalCurrentClimb = (): CurrentClimbDataType | null => {
  return useContext(CurrentClimbContext) ?? null;
};

/** Ultra-narrow hook: returns only the UUID of the current climb.
 *  Use this when you only need to know *which* item is current (e.g. for index lookups)
 *  without subscribing to the full CurrentClimbContext object. */
export const useCurrentClimbUuid = (): string | null => {
  return useContext(CurrentClimbUuidContext);
};

export const useQueueList = (): QueueListDataType => {
  const context = useContext(QueueListContext);
  if (!context) {
    throw new Error('useQueueList must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useSearchData = (): SearchDataType => {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error('useSearchData must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useSessionData = (): SessionDataType => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSessionData must be used within a GraphQLQueueProvider');
  }
  return context;
};

export const useOptionalSessionData = (): SessionDataType | null => {
  return useContext(SessionContext) ?? null;
};
