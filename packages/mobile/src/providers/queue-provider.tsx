import {
  createContext,
  useContext,
  useReducer,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  queueReducer,
  initialState,
  createQueueSyncCoordinator,
  generateClientId,
  isPlaylistPeekQueueItemUuid,
  playlistSuggestionSourceMatches,
} from '@boardsesh/queue';
import type {
  QueueState,
  QueueAction,
  QueueSearchParams,
  ClimbQueueItem,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import {
  createJoinSessionTracker,
  mapSubscriptionEnvelopeToAction,
  type SubscriptionWireEnvelope,
} from '@boardsesh/queue-runtime';
import { useQueueMutations } from '@boardsesh/queue-react';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { execute } from '@boardsesh/graphql-client';
import { buildBoardPath } from '@boardsesh/board-config';
import { JOIN_SESSION } from '@boardsesh/graphql/operations/queue-session';
import { getWsClient } from '../lib/graphql/ws-client';
import { getHttpClient } from '../lib/graphql/client';
import {
  QUEUE_UPDATES_SUBSCRIPTION,
  CREATE_SESSION,
  END_SESSION,
  type CreateSessionMutationResponse,
  type EndSessionMutationResponse,
} from '../lib/graphql/operations';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { getStoredSessionId, setStoredSessionId, clearStoredSessionId } from '../lib/session-store';
import { findPreviousQueueItem, findNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../lib/queue-conversion';
import { climbToQueueItem } from '../lib/climb-to-queue-item';
import { useToast } from './toast-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';

export type StartSessionConfig = {
  name?: string;
  goal?: string;
  color?: string;
  discoverable?: boolean;
  isPermanent?: boolean;
};

type QueueContextValue = {
  state: QueueState;
  dispatch: React.Dispatch<QueueAction>;
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  addToQueue: (item: ClimbQueueItem) => void;
  removeFromQueue: (uuid: string) => void;
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  clearQueue: () => void;
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  nextClimb: () => void;
  previousClimb: () => void;
  /** Active playlist suggestion source (client-only; survives server syncs). */
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /** Replace the playlist suggestion source that drives swipe-through climbs. */
  setPlaylistSuggestionSource: (source: PlaylistSuggestionSource | null) => void;
  /** Refresh the suggestion source in place (no-op unless it matches the active one). */
  refreshPlaylistSuggestionSource: (source: PlaylistSuggestionSource) => void;
  clearSession: () => Promise<void>;
  endSession: () => Promise<SessionSummary | null>;
  /**
   * Explicitly create a session with optional config (name, goal, etc.).
   * Returns the new sessionId, or null if there is no active board or the
   * mutation failed. No-op (returns existing id) when a session is live.
   */
  startSession: (config?: StartSessionConfig) => Promise<string | null>;
};

const QueueContext = createContext<QueueContextValue | null>(null);

export function useQueue(): QueueContextValue {
  const context = useContext(QueueContext);
  if (!context) throw new Error('useQueue must be used within QueueProvider');
  return context;
}

const defaultSearchParams: QueueSearchParams = {};

// The wire envelope shape matches what QUEUE_UPDATES_SUBSCRIPTION returns —
// the subscription aliases `item`→`addedItem` (disambiguates from the
// overlapping `item` selection on CurrentClimbChanged) and `uuid`→`mirroredUuid`
// (disambiguates from QueueItemRemoved.uuid). Both aliases are first-class on
// `SubscriptionWireEnvelope` so we can use the wire type directly.
type QueueUpdateEvent = SubscriptionWireEnvelope<SubscriptionQueueItem>;

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(queueReducer, defaultSearchParams, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionCreationRef = useRef<Promise<string | null> | null>(null);
  // Playlist suggestion source lives in provider state, NOT the reducer: the
  // reducer clears its suggestion field on full server syncs (INITIAL_QUEUE_DATA
  // / UPDATE_QUEUE), which would wipe the source the moment activation
  // creates/syncs a session — killing swipe-through-playlist. Web keeps it
  // outside the reducer for the same reason. The ref mirrors it so the
  // imperative nextClimb path reads the latest value.
  const [playlistSuggestionSource, setPlaylistSuggestionSourceState] = useState<PlaylistSuggestionSource | null>(null);
  const playlistSuggestionSourceRef = useRef<PlaylistSuggestionSource | null>(null);
  playlistSuggestionSourceRef.current = playlistSuggestionSource;
  const { showToast } = useToast();
  const { showQueueAddedSnackbar } = useQueueSnackbar();
  const { t } = useTranslation('session');

  // JOIN_SESSION cache, keyed by (sessionId, connection epoch). Built once
  // per mount so its inFlight state survives re-renders. Web has a separate
  // implementation inside `persistent-session/hooks/use-session-lifecycle.ts`;
  // adopting this tracker there is a follow-up.
  const joinTracker = useMemo(
    () =>
      createJoinSessionTracker({
        getBoardPath: async () => {
          const activeBoard = await getStoredActiveBoard();
          if (!activeBoard) return null;
          return buildBoardPath(
            activeBoard.boardType,
            activeBoard.layoutId,
            activeBoard.sizeId,
            activeBoard.setIds,
            activeBoard.angle,
          );
        },
        execute: ({ sessionId: sid, boardPath }) =>
          execute(getWsClient(), { query: JOIN_SESSION, variables: { sessionId: sid, boardPath } }),
      }),
    [],
  );
  const ensureJoined = useCallback(
    (sessionIdToJoin: string) => joinTracker.ensureJoined(sessionIdToJoin),
    [joinTracker],
  );

  // Build the sync coordinator once per provider mount. The clientId is
  // generated fresh per app launch (no persistence needed today — only
  // matters within a single WebSocket session for echo suppression). Pass
  // the reducer's dispatch in so the coordinator can prune timed-out
  // pending correlation IDs.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const coordinator = useMemo(
    () =>
      createQueueSyncCoordinator({
        clientId: generateClientId(),
        dispatch: (action) => dispatchRef.current(action),
      }),
    [],
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    getStoredSessionId().then((storedId) => {
      if (__DEV__) {
        console.info(`[session] restored from store: ${storedId ?? '(none)'}`);
      }
      if (storedId) setSessionId(storedId);
    });
  }, []);

  // showToast and t aren't stable callbacks — capture via refs so the WS
  // subscription effect doesn't tear down & re-subscribe on locale change
  // (which would briefly miss in-flight peer events). coordinator and dispatch
  // are stable (useMemo([]) / useReducer respectively) so they can sit in the
  // dep array directly.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!sessionId) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      joinTracker.reset();
      return;
    }

    const wsClient = getWsClient();

    // graphql-ws auto-reconnects, and every reconnect gives us a fresh
    // per-connection ConnectionContext on the backend. Invalidate the join
    // cache on `closed` (not on `connected`) — invalidating on `connected`
    // races mutations issued while the socket is down: they read the
    // resolved-but-stale ref from the dead connection, then graphql-ws sends
    // them over the new socket before the re-issued JOIN_SESSION lands.
    // Bumping the epoch on `closed` makes any cached entry stale by key.
    const unsubClosed = wsClient.on('closed', () => {
      joinTracker.bumpEpoch();
    });
    const logJoinFailure = (err: unknown) => {
      if (__DEV__) console.warn('[queue] joinSession failed', err);
    };
    const unsubConnected = wsClient.on('connected', () => {
      // On initial connect this is a no-op (eager fire below cached the
      // entry at the same epoch); on reconnect `closed` already cleared
      // the ref so this re-fires JOIN_SESSION on the new socket.
      ensureJoined(sessionId).catch(logJoinFailure);
    });

    // Fire the initial join eagerly so mutations issued before the first user
    // interaction still find a resolved promise in joinPromiseRef.
    ensureJoined(sessionId).catch(logJoinFailure);

    const cleanup = wsClient.subscribe<{ queueUpdates: QueueUpdateEvent }>(
      {
        query: QUEUE_UPDATES_SUBSCRIPTION,
        variables: { sessionId },
      },
      {
        next: ({ data }) => {
          if (!data?.queueUpdates) return;
          const result = mapSubscriptionEnvelopeToAction(data.queueUpdates, {
            mapItem: toClimbQueueItem,
            context: { myClientId: coordinator.clientId },
          });
          if (result.kind === 'dispatch') dispatch(result.action);
          // TODO(analytics-parity): web's use-queue-event-subscription.ts
          // tracks peer-broadcast QueueItemAdded/QueueItemRemoved via track().
          // Mobile lacks an analytics module today; revisit once the mobile
          // analytics surface exists.
        },
        error: () => {
          // i18n-keep session:mobile.queue.syncError — called through `tRef.current`,
          // which the orphan checker can't trace back to the session-bound `t`.
          showToastRef.current(tRef.current('mobile.queue.syncError'), 'error');
        },
        complete: () => {},
      },
    );

    unsubscribeRef.current = cleanup;

    return () => {
      cleanup();
      unsubConnected();
      unsubClosed();
      unsubscribeRef.current = null;
      joinTracker.reset();
    };
  }, [sessionId, coordinator, ensureJoined, joinTracker]);

  const createSessionWithConfig = useCallback(
    async (config?: StartSessionConfig): Promise<string | null> => {
      if (sessionIdRef.current) return sessionIdRef.current;
      if (sessionCreationRef.current) return sessionCreationRef.current;

      const createPromise = (async () => {
        const activeBoard = await getStoredActiveBoard();
        if (!activeBoard) return null;

        const boardPath = buildBoardPath(
          activeBoard.boardType,
          activeBoard.layoutId,
          activeBoard.sizeId,
          activeBoard.setIds,
          activeBoard.angle,
        );

        try {
          const response = await getHttpClient().request<CreateSessionMutationResponse>(CREATE_SESSION, {
            input: {
              boardPath,
              latitude: 0,
              longitude: 0,
              discoverable: config?.discoverable ?? false,
              ...(config?.name ? { name: config.name } : {}),
              ...(config?.goal ? { goal: config.goal } : {}),
              ...(config?.color ? { color: config.color } : {}),
              ...(config?.isPermanent ? { isPermanent: config.isPermanent } : {}),
            },
          });
          const newId = response.createSession.id;
          sessionIdRef.current = newId;
          setSessionId(newId);
          await setStoredSessionId(newId);
          return newId;
        } catch {
          showToast(t('mobile.queue.sessionCreateError'), 'error');
          return null;
        } finally {
          sessionCreationRef.current = null;
        }
      })();

      sessionCreationRef.current = createPromise;
      return createPromise;
    },
    [showToast, t],
  );

  // Internal lazy-create path used by addToQueue / setCurrentClimb when the user
  // mutates the queue before explicitly starting a session.
  const ensureSession = useCallback(() => createSessionWithConfig(), [createSessionWithConfig]);

  const ensureSessionRef = useRef(ensureSession);
  ensureSessionRef.current = ensureSession;

  // Server-side queue mutations live in @boardsesh/queue-react (shared with
  // web). The `ensureReady` seam resolves — and on the create-flavoured actions
  // lazily creates — then joins the session before each mutation; returning
  // null makes the action a silent no-op (e.g. removing with no active
  // session). Optimistic local dispatch + correlation tracking stay here; the
  // shared hook only talks to the server and owns the serialize-and-supersede
  // coalescer for rapid swipes.
  const mutations = useQueueMutations<ClimbQueueItem>({
    getClient: () => getWsClient(),
    getSessionId: () => sessionIdRef.current,
    toQueueItemInput: (item) => ({ uuid: item.uuid, climb: item.climb }),
    ensureReady: async (capturedSessionId) => {
      const sessionId = capturedSessionId ?? (await ensureSessionRef.current());
      if (!sessionId) return null;
      await ensureJoined(sessionId);
      return sessionId;
    },
    // Best-effort sync failures (coalescer drains for setCurrent / superseded
    // queue-adds) must not alarm: the local reducer already applied the change
    // and the WS subscription reconciles. Dev-log only — a user-facing "Action
    // failed" on a swipe-to-queue or a rapid current-climb change is noise.
    onBestEffortError: (action, error) => {
      if (__DEV__) console.warn(`[queue] best-effort ${action} failed`, error);
    },
  });

  const addToQueue = useCallback(
    (item: ClimbQueueItem) => {
      // Optimistic local dispatch is the source of truth for the user's queue.
      // The server echoes this item via the WS subscription, but
      // DELTA_ADD_QUEUE_ITEM dedupes by uuid so the echo is a no-op. The shared
      // mutation lazily creates + joins a session purely to SYNC the add to a
      // party. That sync is best-effort: a solo user with no session, an offline
      // phone, or a transient WS error must NOT see "Action failed" when the
      // local queue is already correct. Dev-log only.
      dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item } });
      mutations.addQueueItem(item).catch((error) => {
        if (__DEV__) console.warn('[queue] addQueueItem sync failed', error);
      });
      // Surface the "Climb added to queue · Open" snackbar for every add path.
      showQueueAddedSnackbar();
    },
    [mutations, showQueueAddedSnackbar],
  );

  const removeFromQueue = useCallback(
    (uuid: string) => {
      // Same best-effort model as addToQueue: the reducer already removed the
      // item locally; the server mutation only syncs it to a party session (and
      // no-ops when there's none — it never lazily creates one just to remove).
      dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid } });
      mutations.removeQueueItem(uuid).catch((error) => {
        if (__DEV__) console.warn('[queue] removeQueueItem sync failed', error);
      });
    },
    [mutations],
  );

  const reorderQueue = useCallback(
    (uuid: string, oldIndex: number, newIndex: number) => {
      // Optimistic local reorder; the reducer re-validates uuid-at-oldIndex so
      // the server's QueueReordered echo is a safe no-op.
      const previousQueue = stateRef.current.queue;
      const previousCurrent = stateRef.current.currentClimbQueueItem;
      dispatch({ type: 'DELTA_REORDER_QUEUE_ITEM', payload: { uuid, oldIndex, newIndex } });
      mutations.reorderQueueItem(uuid, oldIndex, newIndex).catch((error) => {
        if (__DEV__) console.warn('[queue] reorderQueueItem sync failed; rolling back', error);
        // Unlike add/remove (idempotent, converge on next sync), a failed reorder
        // would leave this client's order silently diverged from peers. Roll back
        // to the pre-reorder order — that matches the server, which never applied
        // the move — and surface the failure.
        dispatch({ type: 'UPDATE_QUEUE', payload: { queue: previousQueue, currentClimbQueueItem: previousCurrent } });
        showToast(t('mobile.queue.actionFailed'), 'error');
      });
    },
    [mutations, showToast, t],
  );

  const clearQueue = useCallback(() => {
    const itemsToRemove = stateRef.current.queue;
    dispatch({ type: 'CLEAR_QUEUE' });
    setPlaylistSuggestionSourceState(null);
    // Surface at most one toast if any removal fails — a persistent join
    // failure would otherwise toast once per queued item.
    void Promise.allSettled(itemsToRemove.map((item) => mutations.removeQueueItem(item.uuid))).then((results) => {
      if (results.some((result) => result.status === 'rejected')) {
        showToast(t('mobile.queue.actionFailed'), 'error');
      }
    });
  }, [mutations, showToast, t]);

  // Optimistic local dispatch + correlated SET_CURRENT_CLIMB mutation. The
  // reducer stores `correlationId` in pendingCurrentClimbUpdates so the echoed
  // CurrentClimbChanged event (same id in `serverCorrelationId`) is suppressed
  // instead of re-applied.
  const dispatchSetCurrent = useCallback(
    (item: ClimbQueueItem, shouldAddToQueue: boolean, playlistSuggestionSource?: PlaylistSuggestionSource | null) => {
      const correlationId = coordinator.generateCorrelationId();
      dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        // playlistSuggestionSource is client-only state — when present the
        // reducer sets it + prunes suggested-after-current; when undefined it's
        // left unchanged. It is intentionally NOT sent to the server mutation.
        payload: { item, shouldAddToQueue, isServerEvent: false, correlationId, playlistSuggestionSource },
      });
      coordinator.trackPendingMutation(correlationId);
      mutations.setCurrentClimb(item, shouldAddToQueue, correlationId).catch(() => {
        showToast(t('mobile.queue.actionFailed'), 'error');
      });
    },
    [coordinator, mutations, showToast, t],
  );

  const setCurrentClimb = useCallback(
    (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => {
      // Source is client-only provider state (see note above) — set it whenever
      // the caller passes options. Activation passes a source; a fresh
      // climb-list/search open passes null to clear playlist context; re-opening
      // the current climb passes nothing, leaving the source intact.
      if (options) setPlaylistSuggestionSourceState(options.playlistSuggestionSource);
      // Append (fresh-uuid items add to the queue; the reducer's uuid dedup makes
      // re-selecting an existing queue item a no-op add). Re-tapping a playlist
      // climb thus starts a fresh pass — forward-swipe re-appends the rest of the
      // playlist (queue grows 1..10, 1..10), driven by
      // findNextQueueItemWithSuggestions anchoring on the current climb.
      dispatchSetCurrent(item, true, options?.playlistSuggestionSource);
    },
    [dispatchSetCurrent],
  );

  const nextClimb = useCallback(() => {
    const { queue, currentClimbQueueItem } = stateRef.current;
    const nextItem = findNextQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      playlistSuggestionSourceRef.current,
    );
    if (!nextItem) return;
    if (isPlaylistPeekQueueItemUuid(nextItem.uuid)) {
      // Mirror web: turn the transient peek into a real queue item with a fresh
      // uuid so the synthetic `playlist-peek:<uuid>` never reaches the WS
      // mutation (toQueueItemInput sends item.uuid verbatim). suggested:true so
      // suggestion pruning still treats it as suggestion-origin. The peek climb
      // is the queue package's wide Climb; climbToQueueItem only reads the
      // ClimbInput subset, so the cast is runtime-safe.
      const realItem = climbToQueueItem(nextItem.climb as unknown as Parameters<typeof climbToQueueItem>[0], {
        suggested: true,
      });
      dispatchSetCurrent(realItem, true);
    } else {
      dispatchSetCurrent(nextItem, false);
    }
  }, [dispatchSetCurrent]);

  const previousClimb = useCallback(() => {
    const { queue, currentClimbQueueItem } = stateRef.current;
    const prevItem = findPreviousQueueItem(queue, currentClimbQueueItem);
    if (prevItem) dispatchSetCurrent(prevItem, false);
  }, [dispatchSetCurrent]);

  const setPlaylistSuggestionSource = useCallback((source: PlaylistSuggestionSource | null) => {
    setPlaylistSuggestionSourceState(source);
  }, []);

  // No-op unless the incoming source matches the active one (same playlist +
  // activated climb + board) — so a late async refresh can't clobber a newer
  // activation. Mirrors the reducer's REFRESH semantics.
  const refreshPlaylistSuggestionSource = useCallback((source: PlaylistSuggestionSource) => {
    setPlaylistSuggestionSourceState((current) =>
      playlistSuggestionSourceMatches(current, source) ? source : current,
    );
  }, []);

  const clearSession = useCallback(async () => {
    setSessionId(null);
    dispatch({
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });
    setPlaylistSuggestionSourceState(null);
    await clearStoredSessionId();
  }, []);

  const endSession = useCallback(async (): Promise<SessionSummary | null> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return null;

    try {
      const response = await getHttpClient().request<EndSessionMutationResponse>(END_SESSION, {
        sessionId: currentSessionId,
      });
      await clearSession();
      showToast(t('mobile.toast.sessionEnded'), 'success');
      return response.endSession;
    } catch {
      showToast(t('mobile.queue.actionFailed'), 'error');
      return null;
    }
  }, [clearSession, showToast, t]);

  const contextValue = useMemo<QueueContextValue>(
    () => ({
      state,
      dispatch,
      sessionId,
      setSessionId,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      playlistSuggestionSource,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      clearSession,
      endSession,
      startSession: createSessionWithConfig,
    }),
    [
      state,
      sessionId,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      playlistSuggestionSource,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      clearSession,
      endSession,
      createSessionWithConfig,
    ],
  );

  return <QueueContext.Provider value={contextValue}>{children}</QueueContext.Provider>;
}
