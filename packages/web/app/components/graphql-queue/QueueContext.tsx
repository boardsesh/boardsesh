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
import {
  trackQueueOperation,
  trackQueueOperationError,
  resolveQueueOperationMode,
  type QueueOperationMode,
} from '@/app/lib/queue-metrics';

import { dispatchOpenPlayDrawer } from '../queue-control/play-drawer-event';
import { useSessionIdManagement } from './hooks/use-session-id-management';
import { deriveIsDriver } from './driver-state';
import { useQueueRestoration } from './hooks/use-queue-restoration';
import { useQueueEventSubscription } from './hooks/use-queue-event-subscription';
import { usePendingUpdateCleanup } from './hooks/use-pending-update-cleanup';
import { useMutationGuard } from './hooks/use-mutation-guard';
import { useOfflineQueueBuffer } from './hooks/use-offline-queue-buffer';
import { useOfflineReconciliation } from './hooks/use-offline-reconciliation';
import { emitWallConfirm } from '../board-bluetooth-control/wall-confirm-bus';
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
  // Wall driver — distinct from leader. The current driver's participant id,
  // or null when the wall is unclaimed (party only; solo has no driver
  // concept so we report null and treat `isDriver` as true).
  //
  // Prefer the optimistic local claim over the server-confirmed value during
  // the brief window between firing `takeControl` and the `DriverChanged`
  // broadcast landing. Cleared in the DriverChanged effect below, so the
  // server stays authoritative — if we lost a take-control race, the
  // optimistic value flips back to the real driver within one round trip.
  const serverDriverParticipantId = isPersistentSessionActive ? persistentSession.driverParticipantId : null;
  const driverParticipantId = state.optimisticDriverParticipantId ?? serverDriverParticipantId;
  const isDriver = deriveIsDriver({ isPersistentSessionActive, participantId, driverParticipantId });
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
  //
  // DriverChanged also runs through here so the optimistic-driver claim from
  // `takeControl` clears on the authoritative broadcast (no risk of a stuck
  // lit lightbulb), and we resync the wall climb if we lost a take-control
  // race (DriverChanged names someone else — their take-control's wall climb
  // is the truth, our optimistic DELTA_UPDATE_CURRENT_CLIMB needs replacing).
  useEffect(() => {
    if (!isPersistentSessionActive) return;
    const unsubscribe = persistentSession.subscribeToSessionEvents((event) => {
      if (event.__typename === 'WallConfirmedClimb') {
        emitWallConfirm(event.climbUuid);
        return;
      }
      if (event.__typename === 'DriverChanged') {
        const latest = latestRef.current;
        // Authoritative server state has landed — clear any local optimistic
        // claim regardless of who won. The next render reads
        // `serverDriverParticipantId` instead.
        latest.dispatch({ type: 'OPTIMISTIC_CLEAR_DRIVER' });
        // If the new driver isn't us, we lost the race. Resync the wall
        // climb from the server immediately rather than waiting up to 5s for
        // `pendingCurrentClimbUpdates` cleanup to fire — the winner's climb
        // is what's actually on the wall and we want the drawer/bar to flip
        // to it without an obvious lag.
        const localParticipantId = latest.persistentSession.participantId;
        const newDriverId = event.driverParticipantId ?? null;
        if (localParticipantId && newDriverId && newDriverId !== localParticipantId) {
          latest.persistentSession.triggerResync();
        }
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
    isDriver,
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
    isDriver,
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

  // Browse-initiated drawer open. The fork between "send to wall" (solo or
  // driver) and "preview only" (party non-driver) lives here so list rows,
  // list covers, suggestion thumbnails, and logbook rows can share one call
  // site. Mirrors the same driver-vs-preview gate used by the drawer's
  // advanceTo (see play-view-drawer.tsx) and the pivot rules 4 + 5: the
  // driver broadcasts on browse, non-drivers preview without yanking the wall.
  const previewClimbFromBrowse = useCallback(
    (climb: Climb) => {
      const latest = latestRef.current;
      if (latest.isPersistentSessionActive && !latest.isDriver) {
        // Party non-driver: leave state.currentClimbQueueItem alone (it
        // mirrors the wall); ship the climb to the bar's drawer-display
        // state via the existing open-drawer event.
        dispatchOpenPlayDrawer(climb);
        return;
      }
      // Solo, or driver in party: pre-mutate state (broadcasts when party
      // active) then open the drawer. Pass `playlistSuggestionSource: null`
      // so activating a non-playlist climb clears any stale playlist source
      // carried over from a prior activation.
      void setCurrentClimb(climb, { playlistSuggestionSource: null });
      dispatchOpenPlayDrawer();
    },
    [setCurrentClimb],
  );

  // Wall-control claim. Drives the queue-control-bar pivot's lightbulb action.
  //
  // Solo (no party): degrades to `setCurrentClimb(climb)` — the backend
  //   takeControl mutation is a no-op without a session, and the local-only
  //   BLE send path is identical.
  // Party + climb: calls the server takeControl mutation with the climb,
  //   which yanks driver and broadcasts the climb in one round trip. The
  //   local reducer is pre-mutated so the UI updates optimistically, mirroring
  //   setCurrentClimb's pattern.
  // Party + no climb: just claims driver (no wall change).
  const takeControl = useCallback(
    async (climb?: Climb | null): Promise<ClimbQueueItem | null> => {
      const latest = latestRef.current;
      if (latest.guardMutation()) return null;

      // Solo: there's no party server-side driver concept. Fall through to the
      // existing setCurrentClimb path so BLE still gets the climb. Clear the
      // playlist suggestion source — taking wall-control on a climb that the
      // caller didn't tag as a playlist activation isn't a playlist context.
      if (!latest.isPersistentSessionActive) {
        if (!climb) return null;
        return setCurrentClimb(climb, { playlistSuggestionSource: null });
      }

      const startTime = performance.now();
      const mode: QueueOperationMode = latest.isDisconnected ? 'party-offline' : 'party';

      // Optimistic driver claim — the lightbulb (bar + drawer) flips to "I'm
      // driving" before the round-trip. Cleared by the DriverChanged effect
      // when the server's broadcast lands; if we lost the take-control race,
      // that clear flips back to the actual driver and triggers a resync of
      // the wall climb. Read `participantId` off latestRef so we don't capture
      // a stale value (it shifts when join completes).
      const localParticipantId = latest.persistentSession.participantId;
      if (localParticipantId) {
        latest.dispatch({ type: 'OPTIMISTIC_SET_DRIVER', payload: { participantId: localParticipantId } });
      }

      if (!climb) {
        // Driver-only claim, no wall change.
        try {
          if (latest.hasConnected) {
            await latest.persistentSession.takeControl(null);
          }
          trackQueueOperation('takeControl', performance.now() - startTime, mode);
        } catch (error: unknown) {
          console.error('Failed to take control:', error);
          // Roll back the optimistic claim on transport failure — without this
          // the lightbulb would stay "I'm driving" until the next DriverChanged
          // (which the server won't send because the mutation didn't land).
          latest.dispatch({ type: 'OPTIMISTIC_CLEAR_DRIVER' });
          trackQueueOperationError('takeControl', mode);
        }
        return null;
      }

      if (!latest.validateQueueAdd(climb)) {
        // Validation rejection rolls the optimistic claim back too — `validateQueueAdd`
        // can refuse e.g. cross-board adds, in which case the mutation never fires.
        latest.dispatch({ type: 'OPTIMISTIC_CLEAR_DRIVER' });
        return null;
      }

      const newItem = createClimbQueueItem(climb, latest.clientId, latest.currentUserInfo);
      const correlationId = nextCorrelationId();

      // Optimistic local update so the bar/drawer reflect the new wall climb
      // before the server round-trip completes. Matches `setCurrentClimb`'s
      // payload (insertAfterCurrent so the queue-history reads naturally).
      latest.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: true, correlationId },
      });

      if (latest.isDisconnected) {
        latest.offlineBuffer.bufferAddition(newItem);
        trackQueueOperation('takeControl', performance.now() - startTime, mode);
        return newItem;
      }

      if (latest.hasConnected) {
        try {
          await latest.persistentSession.takeControl(newItem);
          trackQueueOperation('takeControl', performance.now() - startTime, mode);
        } catch (error: unknown) {
          console.error('Failed to take control with climb:', error);
          if (correlationId) latest.dispatch({ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId } });
          // Roll back the optimistic driver claim — the mutation didn't land,
          // so the server won't broadcast a DriverChanged to clear it for us.
          latest.dispatch({ type: 'OPTIMISTIC_CLEAR_DRIVER' });
          trackQueueOperationError('takeControl', mode);
        }
      } else {
        trackQueueOperation('takeControl', performance.now() - startTime, mode);
      }

      return newItem;
    },
    [setCurrentClimb],
  );

  const releaseControl = useCallback(async (): Promise<void> => {
    const latest = latestRef.current;
    if (!latest.isPersistentSessionActive) return;
    if (latest.guardMutation()) return;
    if (!latest.hasConnected) return;
    try {
      await latest.persistentSession.releaseControl();
    } catch (error: unknown) {
      console.error('Failed to release control:', error);
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

  const getNextClimbQueueItem = useCallback((options?: { from?: ClimbQueueItem | null; suggestionsOnly?: boolean }) => {
    const latest = latestRef.current;
    // `from` lets the drawer walk preview navigation from its locally-
    // displayed climb without first writing to state.currentClimbQueueItem.
    // Default anchor is the current wall climb, preserving existing callers.
    //
    // `suggestionsOnly` (queue-control-bar pivot, rule 5) is the non-driver
    // swipe path: skip the shared queue entirely and walk only the
    // suggested-climbs feed. The shared queue represents "climbs the driver
    // is committed to," so a non-driver browsing it would scrub through
    // someone else's plan; suggestedClimbs is the catalogue the user is
    // already looking at and is the cleaner preview surface.
    const anchorUuid = options?.from ? options.from.uuid : latest.state.currentClimbQueueItem?.uuid;
    const anchorClimbUuid = options?.from ? options.from.climb?.uuid : latest.state.currentClimbQueueItem?.climb?.uuid;
    const buildSuggestedQueueItem = makeBuildSuggestedQueueItem(latest);
    if (options?.suggestionsOnly) {
      // Non-driver swipe-forward: walk the suggestedClimbs array by index so
      // each tap advances one step. Mirrors the backward branch below — using
      // `find(c => c.uuid !== anchorClimbUuid)` was position-blind and made
      // the non-driver oscillate between suggestions[0] and suggestions[1].
      if (latest.suggestedClimbs && latest.suggestedClimbs.length > 0) {
        const anchorIdx = latest.suggestedClimbs.findIndex((climb: Climb) => climb.uuid === anchorClimbUuid);
        // If the anchor isn't in suggestedClimbs (e.g. anchor is a queue item
        // or the wall climb chosen by the driver), start from the top of the
        // feed.
        const nextClimb = anchorIdx < 0 ? latest.suggestedClimbs[0] : (latest.suggestedClimbs[anchorIdx + 1] ?? null);
        if (nextClimb) return buildSuggestedQueueItem(nextClimb);
      }
      // Suggestions feed empty (no playlist active, no recent search anchor
      // populated yet). Group-session feedback fix: instead of letting the
      // non-driver swipe silently die, walk the current `climbSearchResults`
      // from the anchor's position — still preview, still skips the shared
      // queue (the helper filters queued climbs). The pivot rule "non-driver
      // swipe doesn't navigate the shared queue" is preserved; we're only
      // extending the source of climbs to peek at.
      const fromSearch = findUnqueuedNeighborInSearchResults(
        latest.climbSearchResults,
        anchorClimbUuid,
        latest.state.queue,
        1,
        buildSuggestedQueueItem,
      );
      return fromSearch;
    }
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

  const getPreviousClimbQueueItem = useCallback(
    (options?: { from?: ClimbQueueItem | null; suggestionsOnly?: boolean }) => {
      const latest = latestRef.current;
      const anchorUuid = options?.from ? options.from.uuid : latest.state.currentClimbQueueItem?.uuid;
      const anchorClimbUuid = options?.from
        ? options.from.climb?.uuid
        : latest.state.currentClimbQueueItem?.climb?.uuid;
      const buildSuggestedQueueItem = makeBuildSuggestedQueueItem(latest);
      if (options?.suggestionsOnly) {
        // Non-driver previous: walk the suggestedClimbs array backwards.
        // No fall-through into the queue — that would let a non-driver scrub
        // backwards through someone else's committed plan.
        if (latest.suggestedClimbs && latest.suggestedClimbs.length > 0) {
          const anchorIdx = latest.suggestedClimbs.findIndex((climb: Climb) => climb.uuid === anchorClimbUuid);
          if (anchorIdx > 0) {
            const prevClimb = latest.suggestedClimbs[anchorIdx - 1];
            return prevClimb ? buildSuggestedQueueItem(prevClimb) : null;
          }
        }
        // Empty / no-anchor case: fall through to climbSearchResults (mirrors
        // the forward branch). Still preview, still skips the shared queue.
        return findUnqueuedNeighborInSearchResults(
          latest.climbSearchResults,
          anchorClimbUuid,
          latest.state.queue,
          -1,
          buildSuggestedQueueItem,
        );
      }
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
    },
    [],
  );

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
      takeControl,
      releaseControl,
      startSession: stableStartSession,
      joinSession: stableJoinSession,
      endSession: stableEndSession,
      dismissSessionSummary: stableDismissSessionSummary,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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
      driverParticipantId,
      isDriver,
      lastConnectedBoardSerial,
      isBackendMode: !!backendUrl,
      hasConnected,
      connectionError,
    }),
    [
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
      driverParticipantId,
      isDriver,
      lastConnectedBoardSerial,
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
      driverParticipantId,
      isDriver,
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
      driverParticipantId,
      isDriver,
      lastConnectedBoardSerial,
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
