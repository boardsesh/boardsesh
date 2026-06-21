'use client';

import React, { useState, useContext, createContext, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { useQueueReducer } from '../queue-control/reducer';
import { useQueueDataFetching } from '../queue-control/hooks/use-queue-data-fetching';
import type {
  ClimbQueueItem,
  UserName,
  QueueItemUser,
  AddToQueueSource,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '../queue-control/types';
import {
  getPlaylistPeekQueueItemUuid,
  getPlaylistSuggestedClimbs,
  insertQueueItemAfterCurrent,
  isPlaylistPeekQueueItemUuid,
  pruneSuggestedQueueItemsAfterCurrent,
} from '../queue-control/playlist-suggestions';
import { urlParamsToSearchParams, searchParamsToUrlParams } from '@/app/lib/url-utils';
import type { Climb, SearchRequestPagination } from '@/app/lib/types';
import { usePartyProfile } from '../party-manager/party-profile-context';
import { useWebSocketConnection } from '../connection-manager/websocket-connection-provider';
import { FavoritesProvider } from '../climb-actions/favorites-batch-context';
import { PlaylistsProvider } from '../climb-actions/playlists-batch-context';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import { SUGGESTIONS_THRESHOLD } from '../board-page/constants';
import { useSnackbar } from '../providers/snackbar-provider';
import SessionSummaryDialog from '../session-summary/session-summary-dialog';
import { trackQueueOperation, trackQueueOperationError, resolveQueueOperationMode } from '@/app/lib/queue-metrics';

import { dispatchOpenPlayDrawer } from '../queue-control/play-drawer-event';
import { useSessionIdManagement } from './hooks/use-session-id-management';
import { useQueueRestoration } from './hooks/use-queue-restoration';
import { useQueueEventSubscription } from './hooks/use-queue-event-subscription';
import { usePendingUpdateCleanup } from './hooks/use-pending-update-cleanup';
import { useMutationGuard } from './hooks/use-mutation-guard';
import { useOfflineQueueBuffer } from './hooks/use-offline-queue-buffer';
import { useOfflineReconciliation } from './hooks/use-offline-reconciliation';
import { emitWallConfirm } from '@boardsesh/play-view';
import { useQueueAddValidator } from '../board-lock/use-queue-add-validator';
import { track } from '@/app/lib/analytics';
import {
  emitSessionEnded,
  incrementSessionClimbsAttempted,
  updateSessionPeerCount,
  getActiveTrackedSessionIds,
} from '@/app/lib/session-lifecycle-tracking';
import type {
  GraphQLQueueContextType,
  GraphQLQueueActionsType,
  GraphQLQueueContextProps,
  CurrentClimbDataType,
  QueueListDataType,
  SearchDataType,
  SessionDataType,
} from './types';
import type { SetActiveClimbSource } from './set-active-climb-event';

// Re-export types so direct importers still work.
export type { GraphQLQueueContextType, GraphQLQueueActionsType } from './types';
export type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from './types';

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

const findUnqueuedNeighborInSearchResults = (
  results: readonly Climb[] | null,
  anchorClimbUuid: string | undefined,
  queue: readonly ClimbQueueItem[],
  direction: 1 | -1,
  buildSuggestedItem: (climb: Climb) => ClimbQueueItem,
): ClimbQueueItem | null => {
  if (!results || results.length === 0) return null;
  const anchorIdx = results.findIndex((climb) => climb.uuid === anchorClimbUuid);
  if (anchorIdx < 0) return null;
  for (let i = anchorIdx + direction; i >= 0 && i < results.length; i += direction) {
    const candidate = results[i];
    if (queue.some((queueItem) => queueItem.climb?.uuid === candidate.uuid)) continue;
    return buildSuggestedItem(candidate);
  }
  return null;
};

// Used by the forward fallback for cross-search-session continuity: anchor
// isn't in current climbSearchResults, surface a suggestion that isn't queued.
const pickUnqueuedSuggestion = (
  suggestedClimbs: readonly Climb[],
  queue: readonly ClimbQueueItem[],
  excludeClimbUuid: string | undefined,
): Climb | undefined =>
  suggestedClimbs.find(
    (climb) => climb.uuid !== excludeClimbUuid && !queue.some((queueItem) => queueItem.climb?.uuid === climb.uuid),
  );

// Factory that captures the per-render `latest` snapshot so the returned
// closure has the right clientId / user / playlist mode without taking those
// as positional args at every call site.
const makeBuildSuggestedQueueItem =
  (latest: {
    clientId: UserName;
    currentUserInfo: QueueItemUser | undefined;
    state: { playlistSuggestionSource: PlaylistSuggestionSource | null };
  }) =>
  (climb: Climb): ClimbQueueItem => {
    const item = createClimbQueueItem(climb, latest.clientId, latest.currentUserInfo, true);
    return latest.state.playlistSuggestionSource ? { ...item, uuid: getPlaylistPeekQueueItemUuid(climb.uuid) } : item;
  };

// Actions context (stable; identity never changes after first render).
export const QueueActionsContext = createContext<GraphQLQueueActionsType | undefined>(undefined);
// Combined context — exists for the test-only `useQueueContext` hook and for
// the queue-bridge plumbing in `queue-bridge-context.tsx` which forwards a
// single combined value into the top-level provider tree. Production consumers
// should prefer the fine-grained hooks (`useCurrentClimb`, `useSessionData`,
// `useQueueList`, `useSearchData`).
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
}: GraphQLQueueContextProps) => {
  const searchParamsHook = useSearchParams();
  const initialSearchParams = urlParamsToSearchParams(searchParamsHook);
  const [state, dispatch] = useQueueReducer(initialSearchParams);
  const [countSearchParams, setCountSearchParams] = useState<SearchRequestPagination>(initialSearchParams);

  const isOffBoardMode = propsBaseBoardPath !== undefined;
  const correlationCounterRef = useRef(0);
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('session');

  const { profile, username, avatarUrl } = usePartyProfile();
  const { state: connectionState } = useWebSocketConnection();

  // --- Session ID management ---
  const {
    sessionId,
    baseBoardPath,
    isPersistentSessionActive,
    persistentSession,
    backendUrl,
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

  // --- Queue restoration (from in-memory bridge state or party session) ---
  useQueueRestoration({
    isPersistentSessionActive,
    sessionId,
    baseBoardPath,
    dispatch,
    persistentSession,
  });

  // --- Session & connection derived state ---
  const clientId = isPersistentSessionActive ? persistentSession.clientId : null;
  const participantId = isPersistentSessionActive ? persistentSession.participantId : null;
  const isLeader = isPersistentSessionActive ? persistentSession.isLeader : false;
  // Always-live model: there is no driver role. Any participant who changes the
  // climb broadcasts to everyone (the backend has no driver gate), so the web
  // behaves like solo for every member.
  //
  // `wallConfirmed` is the session-scoped "the wall is currently lit" signal
  // that replaces the party lightbulb's old `isDriver` meaning. It turns ON
  // when any member's BLE phone relays a climb (`WallConfirmedClimb`) and OFF
  // when a member's BLE link drops (`WallDisconnected`). It never clears the
  // current climb. Solo doesn't use it — the solo lightbulb reads
  // `isBluetoothConnected` directly. The state lives in the root
  // persistent-session provider (always mounted) so it survives leaving and
  // remounting a board route; we just read it here.
  const wallConfirmed = isPersistentSessionActive ? persistentSession.isSessionWallLit : false;
  // Pull the session's currently-known BLE board serial through so consumers
  // (the drawer's lightbulb fallback) don't have to reach into the
  // persistent-session context directly.
  const lastConnectedBoardSerial = isPersistentSessionActive
    ? (persistentSession.session?.lastConnectedBoardSerial ?? null)
    : null;
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
      showMessage(t('queueProvider.offlineLimitReached'), 'warning');
    }
  }, [rawOfflineBuffer.isBufferFull, showMessage, t]);

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
  const queueLengthRef = useRef(state.queue.length);
  queueLengthRef.current = state.queue.length;
  useQueueEventSubscription({
    isPersistentSessionActive,
    dispatch,
    persistentSession,
    needsResync: state.needsResync,
    boardLayoutName: boardDetails.layout_name ?? null,
    queueLengthRef,
  });

  // --- Session-event relay ---
  // The BLE-paired phone broadcasts WallConfirmedClimb whenever it relays a
  // climb to the wall. Republish on the local bus so the drawer's lightbulb
  // timer (subscribed locally) dismisses the same way it does in solo,
  // regardless of whether this client did the BLE write or saw a peer do it.
  // The `wallConfirmed` indicator itself is owned by the root persistent-session
  // provider (see `isSessionWallLit`) so it survives route remounts; this relay
  // only drives the local drawer-timer bus.
  useEffect(() => {
    if (!isPersistentSessionActive) return;
    const unsubscribe = persistentSession.subscribeToSessionEvents((event) => {
      if (event.__typename === 'WallConfirmedClimb') {
        emitWallConfirm(event.climbUuid);
      }
    });
    return unsubscribe;
  }, [isPersistentSessionActive, persistentSession.subscribeToSessionEvents]);

  // --- Pending update cleanup ---
  usePendingUpdateCleanup({
    isPersistentSessionActive,
    pendingCurrentClimbUpdates: state.pendingCurrentClimbUpdates,
    dispatch,
    onStalePendingUpdates: persistentSession.triggerResync,
  });

  // --- Session lifecycle: keep peer-count high-water-mark current, emit
  // Session Ended on tab_closed (pagehide). Explicit user_left fires from
  // use-session-id-management's endSession(). ---
  useEffect(() => {
    if (!sessionId) return;
    updateSessionPeerCount(sessionId, users.length);
  }, [sessionId, users.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPageHide = () => {
      for (const activeId of getActiveTrackedSessionIds()) {
        emitSessionEnded(activeId, 'tab_closed');
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);
  // Intentionally NOT emitting Session Ended on connectionState === 'error':
  // graphql-ws errors are routinely transient (network blip, server restart
  // followed by reconnect, suspended tab). Tearing down the session record on
  // every error would mark recoverable hiccups as permanent ends and skip the
  // eventual user_left / tab_closed emission. If we later need a distinct
  // 'server_disconnect' signal we should drive it from confirmed server-side
  // session eviction, not transport state.
  // TODO: idle-timeout 'idle' endedBy reason is not wired — no inactivity
  // timer exists yet that terminates sessions. Add here when one lands.

  // --- Current user info ---
  const currentUserInfo: QueueItemUser | undefined = useMemo(() => {
    if (!profile?.id) return undefined;
    return { id: profile.id, username: username || '', avatarUrl };
  }, [profile?.id, username, avatarUrl]);

  // --- Data fetching ---
  const {
    climbSearchResults,
    suggestedClimbs: searchSuggestedClimbs,
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

  const playlistSuggestedClimbs = useMemo(
    () => getPlaylistSuggestedClimbs(state.playlistSuggestionSource, state.queue),
    [state.playlistSuggestionSource, state.queue],
  );

  const suggestedClimbs = state.playlistSuggestionSource ? playlistSuggestedClimbs : searchSuggestedClimbs;

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

    if (state.playlistSuggestionSource || isFetchingNextPage || !hasMoreResults) return;
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
    state.playlistSuggestionSource,
  ]);

  // --- Queue-add compatibility validator ---
  const validateQueueAdd = useQueueAddValidator();

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
    startSession,
    joinSession,
    endSession,
    dismissSessionSummary,
    fetchMoreClimbs,
    validateQueueAdd,
    boardDetails,
    sessionId,
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
    startSession,
    joinSession,
    endSession,
    dismissSessionSummary,
    fetchMoreClimbs,
    validateQueueAdd,
    boardDetails,
    sessionId,
  };

  // --- Stable action callbacks (read from latestRef, never recreated) ---
  const nextCorrelationId = useCallback((): string | undefined => {
    const { clientId } = latestRef.current;
    return clientId ? `${clientId}-${++correlationCounterRef.current}` : undefined;
  }, []);

  const addToQueue = useCallback((climb: Climb, source: AddToQueueSource = 'unknown') => {
    const startTime = performance.now();
    const latest = latestRef.current;
    if (latest.guardMutation()) return;
    if (!latest.validateQueueAdd(climb)) return;
    const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
    const newItem = createClimbQueueItem(climb, latest.clientId, latest.currentUserInfo);
    latest.dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: newItem } });
    const partyMode = latest.isPersistentSessionActive && latest.persistentSession.users.length > 1;
    // `latest.state.queue.length` reflects the most recent committed render,
    // so two adds dispatched back-to-back in the same tick will both report
    // the same `currentQueueLength + 1`. Acceptable for the queue-churn
    // dashboard tile; the dispatched reducer state will still be correct.
    track('Climb Added to Queue', {
      boardLayout: latest.boardDetails?.layout_name ?? null,
      addedFromTab: source,
      currentQueueLength: latest.state.queue.length + 1,
      partyMode,
    });
    if (latest.isDisconnected && latest.isPersistentSessionActive) {
      latest.offlineBuffer.bufferAddition(newItem);
      trackQueueOperation('addToQueue', performance.now() - startTime, mode);
    } else if (latest.hasConnected && latest.isPersistentSessionActive) {
      latest.persistentSession
        .addQueueItem(newItem)
        .then(() => trackQueueOperation('addToQueue', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to add queue item:', error);
          trackQueueOperationError('addToQueue', mode);
        });
    } else {
      trackQueueOperation('addToQueue', performance.now() - startTime, mode);
    }
  }, []);

  const removeFromQueue = useCallback((item: ClimbQueueItem) => {
    const startTime = performance.now();
    const latest = latestRef.current;
    if (latest.guardMutation()) return;
    const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
    latest.dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: item.uuid } });
    const partyMode = latest.isPersistentSessionActive && latest.persistentSession.users.length > 1;
    track('Climb Removed from Queue', {
      boardLayout: latest.boardDetails?.layout_name ?? null,
      partyMode,
      removedBy: 'self',
    });
    if (!latest.isDisconnected && latest.hasConnected && latest.isPersistentSessionActive) {
      latest.persistentSession
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
  const setCurrentClimb = useCallback(
    async (climb: Climb, options: SetCurrentClimbOptions): Promise<ClimbQueueItem | null> => {
      const startTime = performance.now();
      const latest = latestRef.current;
      if (latest.guardMutation()) return null;
      if (!latest.validateQueueAdd(climb)) return null;
      const { playlistSuggestionSource } = options;
      const previousPlaylistSuggestionSource = latest.state.playlistSuggestionSource;
      const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
      const newItem = createClimbQueueItem(climb, latest.clientId, latest.currentUserInfo);
      const correlationId = nextCorrelationId();
      latest.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: newItem,
          shouldAddToQueue: true,
          insertAfterCurrent: true,
          correlationId,
          playlistSuggestionSource,
        },
      });
      // Central funnel instrumentation — fires from every UI path that
      // activates a new climb (queue list tap, browse preview, playlist
      // activation, SetActiveAction button, lightbulb re-assert). Previously
      // this event only fired from the SetActiveAction button, missing the
      // ~7 other entry points and dropping the "Session Started → Set
      // Active Climb" funnel conversion to ~6%.
      track('Set Active Climb', {
        climbUuid: climb.uuid,
        boardType: climb.boardType ?? null,
        layoutId: climb.layoutId ?? null,
        source: 'setCurrentClimb' satisfies SetActiveClimbSource,
      });
      if (latest.sessionId) incrementSessionClimbsAttempted(latest.sessionId);
      if (latest.isDisconnected && latest.isPersistentSessionActive) {
        latest.offlineBuffer.bufferAddition(newItem);
        trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
      } else if (latest.hasConnected && latest.isPersistentSessionActive) {
        const currentIndex = latest.state.currentClimbQueueItem
          ? latest.state.queue.findIndex((queueItem) => queueItem.uuid === latest.state.currentClimbQueueItem?.uuid)
          : -1;
        const position = currentIndex === -1 ? undefined : currentIndex + 1;
        try {
          if (playlistSuggestionSource) {
            const queueWithNewItem = insertQueueItemAfterCurrent(
              latest.state.queue,
              latest.state.currentClimbQueueItem,
              newItem,
            );
            const prunedQueue = pruneSuggestedQueueItemsAfterCurrent(queueWithNewItem, newItem);
            await latest.persistentSession.setQueue(prunedQueue, newItem);
          } else {
            await latest.persistentSession.addQueueItem(newItem, position);
            await latest.persistentSession.setCurrentClimb(newItem, false, correlationId);
          }
          trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
        } catch (error: unknown) {
          console.error('Failed to set current climb:', error);
          if (correlationId) latest.dispatch({ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId } });
          latest.dispatch({ type: 'SET_PLAYLIST_SUGGESTION_SOURCE', payload: previousPlaylistSuggestionSource });
          trackQueueOperationError('setCurrentClimb', mode);
        }
      } else {
        trackQueueOperation('setCurrentClimb', performance.now() - startTime, mode);
      }
      return newItem;
    },
    [],
  );

  // Browse-initiated drawer open. Always-live model: every participant
  // broadcasts on browse exactly like solo — pre-mutate state (which the
  // persistent session broadcasts when a party session is active) then open
  // the drawer. Pass `playlistSuggestionSource: null` so activating a
  // non-playlist climb clears any stale playlist source carried over from a
  // prior activation.
  const previewClimbFromBrowse = useCallback(
    (climb: Climb) => {
      void setCurrentClimb(climb, { playlistSuggestionSource: null });
      dispatchOpenPlayDrawer();
    },
    [setCurrentClimb],
  );

  // Report this client's own BLE link drop to the session so every member's
  // wall-confirmed lightbulb clears. Best-effort and a no-op in solo (the
  // persistent-session helper short-circuits with no active session).
  const reportWallDisconnect = useCallback(async (): Promise<void> => {
    const latest = latestRef.current;
    if (!latest.isPersistentSessionActive) return;
    if (!latest.hasConnected) return;
    try {
      await latest.persistentSession.reportWallDisconnect();
    } catch (error: unknown) {
      console.error('Failed to report wall disconnect:', error);
    }
  }, []);

  // Replace an existing queue item in place with a new climb, preserving the
  // queue-item uuid and the existing addedBy attribution. Used by the create
  // form on subsequent saves so the queue item stays in the same slot instead
  // of piling up duplicates.
  const replaceQueueItem = useCallback((queueItemUuid: string, climb: Climb) => {
    const startTime = performance.now();
    const latest = latestRef.current;
    if (latest.guardMutation()) return;
    if (!latest.validateQueueAdd(climb)) return;
    const existing = latest.state.queue.find((qItem) => qItem.uuid === queueItemUuid);
    const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
    const base = createClimbQueueItem(climb, latest.clientId, latest.currentUserInfo);
    const newItem: ClimbQueueItem = {
      ...base,
      uuid: queueItemUuid,
      addedBy: existing?.addedBy ?? base.addedBy,
      addedByUser: existing?.addedByUser ?? base.addedByUser,
      tickedBy: existing?.tickedBy,
    };
    latest.dispatch({
      type: 'DELTA_REPLACE_QUEUE_ITEM',
      payload: { uuid: queueItemUuid, item: newItem },
    });
    if (!latest.isDisconnected && latest.hasConnected && latest.isPersistentSessionActive) {
      latest.persistentSession
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
    const latest = latestRef.current;
    if (latest.guardMutation()) return;
    const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
    latest.dispatch({
      type: 'UPDATE_QUEUE',
      payload: { queue, currentClimbQueueItem: latest.state.currentClimbQueueItem },
    });
    if (!latest.isDisconnected && latest.hasConnected && latest.isPersistentSessionActive) {
      latest.persistentSession
        .setQueue(queue, latest.state.currentClimbQueueItem)
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
    const latest = latestRef.current;
    if (latest.guardMutation()) return;
    // Playlist "peek" items use a deterministic synthetic uuid so repeated
    // peeks of the same suggestion produce a stable queue uuid. Once a peek
    // is promoted to the actual current climb, mint a fresh queue-item uuid
    // so it lives as a regular queue entry rather than a transient peek.
    const queueItem = isPlaylistPeekQueueItemUuid(item.uuid)
      ? createClimbQueueItem(item.climb, latest.clientId, latest.currentUserInfo, item.suggested)
      : item;
    const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
    const correlationId = nextCorrelationId();
    latest.dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: queueItem, shouldAddToQueue: queueItem.suggested, correlationId },
    });
    if (queueItem.climb) {
      track('Set Active Climb', {
        climbUuid: queueItem.climb.uuid,
        boardType: queueItem.climb.boardType ?? null,
        layoutId: queueItem.climb.layoutId ?? null,
        source: 'setCurrentClimbQueueItem' satisfies SetActiveClimbSource,
      });
    }
    if (latest.sessionId) incrementSessionClimbsAttempted(latest.sessionId);
    if (!latest.isDisconnected && latest.hasConnected && latest.isPersistentSessionActive) {
      latest.persistentSession
        .setCurrentClimb(queueItem, queueItem.suggested, correlationId)
        .then(() => trackQueueOperation('setCurrentClimbQueueItem', performance.now() - startTime, mode))
        .catch((error: unknown) => {
          console.error('Failed to set current climb:', error);
          if (correlationId) latest.dispatch({ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId } });
          trackQueueOperationError('setCurrentClimbQueueItem', mode);
        });
    } else {
      trackQueueOperation('setCurrentClimbQueueItem', performance.now() - startTime, mode);
    }
  }, []);

  const setPlaylistSuggestionSource = useCallback((source: PlaylistSuggestionSource | null) => {
    latestRef.current.dispatch({ type: 'SET_PLAYLIST_SUGGESTION_SOURCE', payload: source ?? null });
  }, []);

  const refreshPlaylistSuggestionSource = useCallback((source: PlaylistSuggestionSource) => {
    latestRef.current.dispatch({ type: 'REFRESH_PLAYLIST_SUGGESTION_SOURCE', payload: source });
  }, []);

  const setClimbSearchParams = useCallback((params: SearchRequestPagination) => {
    const latest = latestRef.current;
    latest.dispatch({ type: 'SET_CLIMB_SEARCH_PARAMS', payload: params });
    if (!latest.isOffBoardMode) {
      const urlParams = searchParamsToUrlParams(params);
      const queryString = urlParams.toString();
      const newUrl = queryString ? `${latest.pathname}?${queryString}` : latest.pathname;
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, []);

  const setCountSearchParamsAction = useCallback((params: SearchRequestPagination) => {
    latestRef.current.setCountSearchParams(params);
  }, []);

  const mirrorClimb = useCallback(() => {
    const startTime = performance.now();
    const latest = latestRef.current;
    if (latest.guardMutation()) return;
    if (!latest.state.currentClimbQueueItem?.climb) return;
    const mode = resolveQueueOperationMode(latest.isPersistentSessionActive, latest.isDisconnected);
    const newMirroredState = !latest.state.currentClimbQueueItem.climb?.mirrored;
    // Local-origin dispatch: pass the current climb's uuid so the reducer's
    // server-event uuid guard is a no-op here (it only suppresses when uuid
    // diverges).
    latest.dispatch({
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      payload: { mirrored: newMirroredState, mirroredUuid: latest.state.currentClimbQueueItem.uuid },
    });
    if (!latest.isDisconnected && latest.hasConnected && latest.isPersistentSessionActive) {
      latest.persistentSession
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

  const getNextClimbQueueItem = useCallback((options?: { from?: ClimbQueueItem | null }) => {
    const latest = latestRef.current;
    // `from` lets the drawer walk navigation from its locally-displayed climb
    // without first writing to state.currentClimbQueueItem. Default anchor is
    // the current wall climb, preserving existing callers. Always-live model:
    // every participant navigates the shared queue (there is no non-driver
    // suggestions-only path).
    const anchorUuid = options?.from ? options.from.uuid : latest.state.currentClimbQueueItem?.uuid;
    const anchorClimbUuid = options?.from ? options.from.climb?.uuid : latest.state.currentClimbQueueItem?.climb?.uuid;
    const buildSuggestedQueueItem = makeBuildSuggestedQueueItem(latest);
    const queue = latest.state.queue;
    // With no anchor at all (no current climb, no `from`), Next surfaces queue[0]
    // so the Queue bar's Next button can start a queue the user has built but
    // not yet activated. If the queue is also empty, fall through to
    // suggestedClimbs[0] so a fresh load with populated suggestions still
    // exposes a Next.
    if (anchorUuid == null) {
      if (queue[0]) return queue[0];
      const firstSuggestion = latest.suggestedClimbs[0];
      return firstSuggestion ? buildSuggestedQueueItem(firstSuggestion) : null;
    }
    const queueItemIndex = queue.findIndex((queueItem: ClimbQueueItem) => queueItem.uuid === anchorUuid);
    if (queueItemIndex >= 0 && queueItemIndex < queue.length - 1) {
      return queue[queueItemIndex + 1];
    }
    // Playlist-suggestion mode: suggestedClimbs is the curated next-up feed
    // (climbs after the activated one, queued items already filtered out).
    // The anchor isn't in this feed, so position-based walking doesn't apply —
    // the next-up is whatever sits at the head.
    if (latest.state.playlistSuggestionSource) {
      const nextClimb = latest.suggestedClimbs[0];
      return nextClimb ? buildSuggestedQueueItem(nextClimb) : null;
    }
    const fromSearch = findUnqueuedNeighborInSearchResults(
      latest.climbSearchResults,
      anchorClimbUuid,
      queue,
      1,
      buildSuggestedQueueItem,
    );
    if (fromSearch) return fromSearch;
    // Cross-search-session continuity: anchor isn't in current
    // climbSearchResults (e.g. queue was built from a previous search). Surface
    // the first unqueued suggestion rather than dead-ending the Next button.
    const fallback = pickUnqueuedSuggestion(latest.suggestedClimbs, queue, anchorClimbUuid);
    return fallback ? buildSuggestedQueueItem(fallback) : null;
  }, []);

  const getPreviousClimbQueueItem = useCallback((options?: { from?: ClimbQueueItem | null }) => {
    const latest = latestRef.current;
    const anchorUuid = options?.from ? options.from.uuid : latest.state.currentClimbQueueItem?.uuid;
    const anchorClimbUuid = options?.from ? options.from.climb?.uuid : latest.state.currentClimbQueueItem?.climb?.uuid;
    const buildSuggestedQueueItem = makeBuildSuggestedQueueItem(latest);
    // No anchor (no current climb, no `from`): backward navigation has no
    // semantic answer — don't fabricate one from suggestions. Forward
    // surfaces queue[0] to start an unactivated queue; backward has no
    // symmetric "start" semantics.
    if (anchorUuid == null) return null;
    const queue = latest.state.queue;
    const queueItemIndex = queue.findIndex((queueItem: ClimbQueueItem) => queueItem.uuid === anchorUuid);
    if (queueItemIndex > 0) return queue[queueItemIndex - 1];
    // In playlist-suggestion mode there's no "previous playlist climb" once
    // the activated climb is current — the playlist is consumed forward
    // only. Don't fall through to climbSearchResults, that would surface
    // unrelated results.
    if (latest.state.playlistSuggestionSource) return null;
    // Backward navigation is history-oriented: the queue walk above is the
    // history step. When neither queue nor search results yield a backward
    // neighbour, don't fall through to suggestedClimbs — that's discovery
    // (the forward direction).
    return findUnqueuedNeighborInSearchResults(
      latest.climbSearchResults,
      anchorClimbUuid,
      queue,
      -1,
      buildSuggestedQueueItem,
    );
  }, []);

  // Optimistic dispatch for widget navigation (Next/Previous from Live Activity).
  // The native WebSocket already sent the server mutation, so we only need to
  // update the local reducer state and register the correlationId for echo suppression.
  const dispatchWidgetNavigation = useCallback((item: ClimbQueueItem, correlationId: string) => {
    const latest = latestRef.current;
    latest.dispatch({
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
  // Every callback in this object is identity-stable: each `useCallback` here
  // uses `[]` (or `[setCurrentClimb]` where `setCurrentClimb` itself uses `[]`),
  // so the references in the closure never change between renders. The dep
  // array can therefore be empty — the memo computes once and the same
  // reference is reused for the lifetime of the provider.
  const actionsValue: GraphQLQueueActionsType = useMemo(
    () => ({
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      previewClimbFromBrowse,
      setQueue,
      setCurrentClimbQueueItem,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      replaceQueueItem,
      setClimbSearchParams,
      setCountSearchParams: setCountSearchParamsAction,
      mirrorClimb,
      fetchMoreClimbs: stableFetchMoreClimbs,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      disconnect: stableDisconnect,
      dispatchWidgetNavigation,
      reportWallDisconnect,
      startSession: stableStartSession,
      joinSession: stableJoinSession,
      endSession: stableEndSession,
      dismissSessionSummary: stableDismissSessionSummary,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --- Combined context value (used by the test-only `useQueueContext` hook
  // and by the queue-bridge plumbing). Composes actionsValue with every data
  // field directly — the data fields no longer live in their own context, so
  // there's no separate `dataValue` memo to compute. Production consumers
  // should reach for the fine-grained hooks below instead. ---
  const contextValue: GraphQLQueueContextType = useMemo(
    () => ({
      ...actionsValue,
      queue: state.queue,
      currentClimbQueueItem: state.currentClimbQueueItem,
      currentClimb: state.currentClimbQueueItem?.climb || null,
      climbSearchParams: state.climbSearchParams,
      climbSearchResults,
      suggestedClimbs,
      playlistSuggestionSource: state.playlistSuggestionSource,
      totalSearchResultCount,
      hasMoreResults,
      isFetchingClimbs,
      isFetchingNextPage,
      hasDoneFirstFetch: state.hasDoneFirstFetch,
      viewOnlyMode,
      parsedParams,
      isSessionActive,
      isPersistentSessionActive,
      sessionId,
      sessionSummary,
      sessionGoal: isPersistentSessionActive ? (persistentSession.session?.goal ?? null) : null,
      connectionState,
      canMutate,
      isDisconnected,
      users,
      clientId,
      participantId,
      isLeader,
      wallConfirmed,
      lastConnectedBoardSerial,
      isBackendMode: !!backendUrl,
      hasConnected,
      connectionError,
    }),
    [
      actionsValue,
      state.queue,
      state.currentClimbQueueItem,
      state.climbSearchParams,
      state.playlistSuggestionSource,
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
      participantId,
      isLeader,
      wallConfirmed,
      lastConnectedBoardSerial,
      backendUrl,
      hasConnected,
      connectionError,
    ],
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
      isPersistentSessionActive,
      sessionId,
      sessionSummary,
      sessionGoal: isPersistentSessionActive ? (persistentSession.session?.goal ?? null) : null,
      connectionState,
      canMutate,
      isDisconnected,
      users,
      clientId,
      participantId,
      isLeader,
      wallConfirmed,
      lastConnectedBoardSerial,
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
      participantId,
      isLeader,
      wallConfirmed,
      lastConnectedBoardSerial,
      backendUrl,
      hasConnected,
      connectionError,
    ],
  );

  return (
    <QueueActionsContext.Provider value={actionsValue}>
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
