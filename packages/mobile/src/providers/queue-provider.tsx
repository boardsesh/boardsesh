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
  ClimbRegradePatch,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import {
  applySessionRuntimeEvent,
  createJoinSessionTracker,
  createReleaseControlOptimisticPlan,
  createTakeControlOptimisticPlan,
  mapSubscriptionEnvelopeToAction,
  shouldRollbackReleaseControlDriver,
  shouldRollbackTakeControlDriver,
  shouldRollbackTakeControlQueue,
  shouldSurfaceReleaseControlFailure,
  type RuntimeSessionState,
  type SubscriptionWireEnvelope,
} from '@boardsesh/queue-runtime';
import { useQueueMutations, type PublishPlaybackStateInput } from '@boardsesh/queue-react';
import type { SessionSummary, SubscriptionQueueEvent, SessionUser, UserBoard } from '@boardsesh/shared-schema';
import { execute } from '@boardsesh/graphql-client';
import { buildBoardPath, parseBoardPath } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { JOIN_SESSION } from '@boardsesh/graphql/operations/queue-session';
import { getWsClient } from '../lib/graphql/ws-client';
import { getHttpClient } from '../lib/graphql/client';
import {
  QUEUE_UPDATES_SUBSCRIPTION,
  SESSION_UPDATES_SUBSCRIPTION,
  CREATE_SESSION,
  END_SESSION,
  GET_CLIMB,
  type CreateSessionMutationResponse,
  type EndSessionMutationResponse,
  type SessionUpdateEvent,
  type SessionLiveStatsEvent,
  type GetClimbQueryResponse,
} from '../lib/graphql/operations';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import { getStoredSessionId, setStoredSessionId, clearStoredSessionId } from '../lib/session-store';
import { emitWallConfirm, findPreviousQueueItem, findNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../lib/queue-conversion';
import { toMobileSessionRuntimeEvent } from '../lib/session-runtime-event';
import { climbToQueueItem, toClimbInput } from '../lib/climb-to-queue-item';
import { track } from '../lib/analytics';
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
  /** Participant id of the member currently driving the wall, if any. */
  driverParticipantId: string | null;
  /** Most recently published physical board serial for this session, if any. */
  lastConnectedBoardSerial: string | null;
  /** Our own participant id for the active session (marks "you" in rosters). */
  participantId: string | null;
  addToQueue: (item: ClimbQueueItem) => void;
  removeFromQueue: (uuid: string) => void;
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  clearQueue: () => void;
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  nextClimb: () => void;
  previousClimb: () => void;
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
  /**
   * Join an existing session created by someone else (party mode). Switches the
   * active board to the session's board, sets + persists the sessionId, and
   * relies on the session effect to run JOIN_SESSION + open the realtime
   * subscriptions. No-ops if already in this session. Differs from
   * `startSession`, which *reads* the active board to create a new session;
   * `joinSession` *writes* the active board from the session's boardPath.
   */
  joinSession: (sessionId: string, opts: { boardPath: string; userBoard: UserBoard }) => Promise<void>;
  /**
   * Broadcast the session's boardPath so every party member follows the same
   * angle/board. Best-effort; a true no-op in solo (never creates a session).
   */
  setSessionBoardPath: (boardPath: string) => Promise<void>;
  /**
   * Claim wall-control authority in the current party session, optionally with
   * the climb that should become the driver's wall climb. Best-effort no-op
   * when no session is active.
   */
  takeControl: (item?: ClimbQueueItem | null, options?: TakeControlOptions) => Promise<void>;
  /** Release wall-control authority in the current party session. */
  releaseControl: () => Promise<void>;
  /**
   * Broadcast that this phone successfully wrote a climb to the physical wall.
   * The local wall-confirm bus is handled by the Bluetooth provider; this
   * mutation notifies party peers through the session subscription.
   */
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
  /**
   * Store the connected board serial on the active session so native peers can
   * reconnect to the same physical wall without showing the picker.
   */
  setSessionBoardSerial: (serial: string) => Promise<void>;
  /**
   * Subscribe to raw queue subscription events, including transient ones that
   * never reach the reducer (PlaybackStateChanged drives route playback
   * party-sync). Returns an unsubscribe function.
   */
  subscribeToQueueEvents: (listener: (event: SubscriptionQueueEvent) => void) => () => void;
  /** Broadcast local route-playback state to party peers. Best-effort; no-op solo. */
  publishPlaybackState: (input: PublishPlaybackStateInput) => Promise<void>;
};

const QueueContext = createContext<QueueContextValue | null>(null);

/**
 * QueueProvider intentionally exposes several narrow hooks. Pick the smallest
 * subscription that matches the read:
 * - useQueue(): legacy/full reducer state plus actions; use only when state shape is required.
 * - useQueueActions(): stable command surface for enqueue/session/playback writes.
 * - useQueueSessionId(): rare session-id changes for structural chrome.
 * - useQueueSessionControls(): session id plus driver/serial controls for party surfaces.
 * - useQueueLiveStats(): high-frequency live stats and roster updates.
 * - useActiveClimbUuid(): row-level active-climb highlighting.
 * - useHasActiveClimb(): presence-only bottom chrome metrics.
 * - usePlaylistSuggestionSource(): playlist peek/suggestion navigation.
 */
type TakeControlOptions = {
  playlistSuggestionSource?: PlaylistSuggestionSource | null;
};
type QueueSessionControlContextValue = Pick<
  QueueContextValue,
  | 'sessionId'
  | 'driverParticipantId'
  | 'participantId'
  | 'lastConnectedBoardSerial'
  | 'takeControl'
  | 'releaseControl'
  | 'confirmClimbOnWall'
  | 'setSessionBoardSerial'
>;

const QueueSessionControlContext = createContext<QueueSessionControlContextValue | null>(null);

/**
 * SessionId-only selector context. Its identity changes ONLY when the active
 * session id changes (session start / end / join — rare), never on queue
 * mutations or the ≤1/2s party pushes. Consumed by high-fanout *structural*
 * readers — the tab layout (which renders every tab inline), the board adapter,
 * and the session screen — so a queue change can't cascade a re-render through
 * the whole navigation tree. Narrower than QueueSessionControlContext, which
 * also churns on driver / board-serial changes.
 */
type QueueSessionIdContextValue = {
  sessionId: string | null;
};

const QueueSessionIdContext = createContext<QueueSessionIdContextValue | null>(null);

/**
 * Live session analytics + presence, split out of the main QueueContext so the
 * ≤1/2s `SessionStatsUpdated` party push (and roster deltas) re-renders only the
 * session screen — not every `useQueue()` consumer (climb list, persistent bar,
 * tab layout, board adapter, bluetooth provider, drawer host, live-activity
 * bridge). Consumed solely by SessionScreen + InSessionView.
 */
type QueueLiveStatsContextValue = {
  /**
   * Live aggregate stats for the active session, pushed over `sessionUpdates`
   * (the `SessionStatsUpdated` event) as ticks are logged. Null until the first
   * push arrives (or when there's no session).
   */
  liveStats: SessionLiveStatsEvent | null;
  /**
   * Connected participants in the active session. Seeded from the JOIN_SESSION
   * response and kept current via UserJoined/UserLeft/UserPresenceChanged.
   */
  sessionUsers: SessionUser[];
};

const QueueLiveStatsContext = createContext<QueueLiveStatsContextValue | null>(null);

/**
 * Active-climb selector context. Changes identity ONLY when the active climb's
 * uuid changes, so the climb list (which highlights the active row) stops
 * re-rendering on every unrelated queue mutation or party push.
 */
type QueueActiveClimbContextValue = {
  activeClimbUuid: string | null;
};

const QueueActiveClimbContext = createContext<QueueActiveClimbContextValue | null>(null);

/**
 * Boolean "is any climb currently active" selector. Identity changes ONLY when a
 * climb appears/disappears (none↔some) — NOT when navigating *between* climbs.
 * Consumed by bottom-chrome metrics (climbs, discover, You screens) so navigating
 * climbs in the play drawer no longer re-renders those whole tab screens.
 */
type QueueHasActiveClimbContextValue = {
  hasActiveClimb: boolean;
};

const QueueHasActiveClimbContext = createContext<QueueHasActiveClimbContextValue | null>(null);

/**
 * Stable queue actions, split out so consumers that only dispatch actions (e.g.
 * the climb list's add-to-queue) don't subscribe to the whole reducer `state`.
 * Holds everything in QueueContextValue except volatile state and selector-only
 * values. Playlist suggestion state lives in QueuePlaylistSuggestionContext so
 * playlist activation does not wake every action-only consumer in the tab tree.
 */
type QueueActionsContextValue = Omit<
  QueueContextValue,
  | 'state'
  | 'dispatch'
  | 'sessionId'
  | 'setSessionId'
  | 'driverParticipantId'
  | 'lastConnectedBoardSerial'
  | 'participantId'
>;

const QueueActionsContext = createContext<QueueActionsContextValue | null>(null);

type QueuePlaylistSuggestionContextValue = {
  playlistSuggestionSource: PlaylistSuggestionSource | null;
};

const QueuePlaylistSuggestionContext = createContext<QueuePlaylistSuggestionContextValue | null>(null);

export function useQueue(): QueueContextValue {
  const context = useContext(QueueContext);
  if (!context) throw new Error('useQueue must be used within QueueProvider');
  return context;
}

export function useQueueSessionControls(): QueueSessionControlContextValue {
  const context = useContext(QueueSessionControlContext);
  if (!context) throw new Error('useQueueSessionControls must be used within QueueProvider');
  return context;
}

export function useQueueSessionId(): QueueSessionIdContextValue {
  const context = useContext(QueueSessionIdContext);
  if (!context) throw new Error('useQueueSessionId must be used within QueueProvider');
  return context;
}

export function useQueueLiveStats(): QueueLiveStatsContextValue {
  const context = useContext(QueueLiveStatsContext);
  if (!context) throw new Error('useQueueLiveStats must be used within QueueProvider');
  return context;
}

export function useActiveClimbUuid(): string | null {
  const context = useContext(QueueActiveClimbContext);
  if (!context) throw new Error('useActiveClimbUuid must be used within QueueProvider');
  return context.activeClimbUuid;
}

export function useHasActiveClimb(): boolean {
  const context = useContext(QueueHasActiveClimbContext);
  if (!context) throw new Error('useHasActiveClimb must be used within QueueProvider');
  return context.hasActiveClimb;
}

export function useQueueActions(): QueueActionsContextValue {
  const context = useContext(QueueActionsContext);
  if (!context) throw new Error('useQueueActions must be used within QueueProvider');
  return context;
}

export function usePlaylistSuggestionSource(): PlaylistSuggestionSource | null {
  const context = useContext(QueuePlaylistSuggestionContext);
  if (!context) throw new Error('usePlaylistSuggestionSource must be used within QueueProvider');
  return context.playlistSuggestionSource;
}

const defaultSearchParams: QueueSearchParams = {};

// The wire envelope shape matches what QUEUE_UPDATES_SUBSCRIPTION returns —
// the subscription aliases `item`→`addedItem` (disambiguates from the
// overlapping `item` selection on CurrentClimbChanged) and `uuid`→`mirroredUuid`
// (disambiguates from QueueItemRemoved.uuid). Both aliases are first-class on
// `SubscriptionWireEnvelope` so we can use the wire type directly.
type QueueUpdateEvent = SubscriptionWireEnvelope<SubscriptionQueueItem>;
type MobileSessionRuntimeState = RuntimeSessionState<SessionUser>;

const createEmptySessionRuntimeState = (): MobileSessionRuntimeState => ({
  users: [],
  isLeader: false,
  clientId: '',
  driverParticipantId: null,
  lastConnectedBoardSerial: null,
  boardPath: '',
});

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(queueReducer, defaultSearchParams, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Live session analytics + presence. liveStats is pushed over `sessionUpdates`
  // (SessionStatsUpdated); the roster is seeded from JOIN_SESSION and kept
  // current via UserJoined/UserLeft/UserPresenceChanged/DriverChanged.
  const [liveStats, setLiveStats] = useState<SessionLiveStatsEvent | null>(null);
  const [sessionRuntimeState, setSessionRuntimeState] =
    useState<MobileSessionRuntimeState>(createEmptySessionRuntimeState);
  const sessionRuntimeStateRef = useRef(sessionRuntimeState);
  sessionRuntimeStateRef.current = sessionRuntimeState;
  const sessionUsers = sessionRuntimeState.users;
  const driverParticipantId = sessionRuntimeState.driverParticipantId;
  const lastConnectedBoardSerial = sessionRuntimeState.lastConnectedBoardSerial;
  const [participantId, setParticipantId] = useState<string | null>(null);
  // Our own participant id, captured from the JOIN_SESSION response. Used to
  // suppress the echo of our own SessionBoardPathChanged broadcasts (the server
  // stamps `changedByParticipantId` with the originator's participant id).
  const participantIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const wallControlOperationRef = useRef(0);

  // The active board is the angle source of truth. Read it here so the
  // self-healing re-grade effect can compare each queued climb's display angle
  // to the live angle, and so inbound SessionBoardPathChanged events can write
  // the new angle back. `setActiveBoard` is stable; keep a ref for the WS
  // handler so the subscription effect doesn't re-subscribe on board changes.
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const setActiveBoardRef = useRef(setActiveBoard);
  setActiveBoardRef.current = setActiveBoard;
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

  // The active board is read synchronously from the React Query cache
  // (staleTime: Infinity, hydrated from AsyncStorage) so analytics call sites
  // can tag events with the current board layout without re-creating the
  // callbacks on every board switch — mirror it into a ref the handlers read.
  const activeBoardRef = useRef(activeBoard);
  activeBoardRef.current = activeBoard;

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
        execute: async ({ sessionId: sid, boardPath }) => {
          const result = await execute<{
            joinSession?: {
              participantId?: string | null;
              clientId?: string | null;
              isLeader?: boolean | null;
              driverParticipantId?: string | null;
              lastConnectedBoardSerial?: string | null;
              boardPath?: string | null;
              users?: SessionUser[] | null;
            };
          }>(getWsClient(), {
            query: JOIN_SESSION,
            variables: { sessionId: sid, boardPath },
          });
          const joined = result?.joinSession;
          // Remember our participant id so we can ignore the echo of our own
          // board-path broadcasts. Only overwrite on a concrete value.
          if (joined?.participantId) {
            participantIdRef.current = joined.participantId;
            setParticipantId(joined.participantId);
          }
          // Seed the live presence roster + driver from the join response. The
          // UserJoined/UserLeft/DriverChanged events that follow are deltas;
          // this is the initial snapshot of who's already in the session.
          setSessionRuntimeState({
            users: joined?.users ?? [],
            isLeader: joined?.isLeader ?? false,
            clientId: joined?.clientId ?? joined?.participantId ?? '',
            driverParticipantId: joined?.driverParticipantId ?? null,
            lastConnectedBoardSerial: joined?.lastConnectedBoardSerial ?? null,
            boardPath: joined?.boardPath ?? boardPath,
          });
          return result;
        },
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
    void getStoredSessionId().then((storedId) => {
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
  const clearSessionRef = useRef<() => Promise<void>>(async () => {});
  const locallyEndingSessionIdRef = useRef<string | null>(null);
  const suppressedRemoteEndSessionIdRef = useRef<string | null>(null);

  // Transient queue-event listeners. PlaybackStateChanged (route playback
  // party-sync) doesn't mutate queue state, so the play-drawer orchestrator
  // subscribes here and the reducer path skips it. Listeners live in a ref so
  // adding/removing one never tears down the WS subscription effect below.
  const queueEventListenersRef = useRef<Set<(event: SubscriptionQueueEvent) => void>>(new Set());
  const subscribeToQueueEvents = useCallback((listener: (event: SubscriptionQueueEvent) => void) => {
    queueEventListenersRef.current.add(listener);
    return () => {
      queueEventListenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      participantIdRef.current = null;
      setParticipantId(null);
      setLiveStats(null);
      setSessionRuntimeState(createEmptySessionRuntimeState());
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
          const event = data.queueUpdates;
          // Forward every event to transient-event listeners (route playback
          // party-sync) before the reducer path. The wire-envelope type doesn't
          // model PlaybackStateChanged, but the subscription selects it and the
          // server emits it — SubscriptionQueueEvent is the canonical client
          // union that includes it.
          // TODO(#2507): add PlaybackStateChanged to SubscriptionWireEnvelope so
          // this `as unknown as` cast can be removed (don't strip it before then).
          const queueEvent = event as unknown as SubscriptionQueueEvent;
          if (queueEventListenersRef.current.size > 0) {
            for (const listener of queueEventListenersRef.current) {
              try {
                listener(queueEvent);
              } catch (listenerError) {
                if (__DEV__) console.warn('[queue] queue-event listener threw', listenerError);
              }
            }
          }
          // PlaybackStateChanged is transient — it carries no queue state and
          // reuses the room's current sequence, so it bypasses the reducer.
          if (queueEvent.__typename === 'PlaybackStateChanged') return;
          const result = mapSubscriptionEnvelopeToAction(event, {
            mapItem: toClimbQueueItem,
            context: { myClientId: coordinator.clientId },
          });
          if (result.kind !== 'dispatch') return;
          dispatch(result.action);
          switch (result.eventType) {
            case 'QueueItemAdded':
              track(SHARED_EVENTS.ClimbAddedToQueue, {
                boardName: activeBoardRef.current?.boardType,
                layoutId: activeBoardRef.current?.layoutId,
                addedFromTab: 'peer_broadcast',
                currentQueueLength: stateRef.current.queue.length + 1,
                partyMode: true,
              });
              break;
            case 'QueueItemRemoved':
              track(SHARED_EVENTS.ClimbRemovedFromQueue, {
                boardName: activeBoardRef.current?.boardType,
                layoutId: activeBoardRef.current?.layoutId,
                partyMode: true,
                removedBy: 'peer',
              });
              break;
            case 'QueueReordered':
              if (event.__typename === 'QueueReordered') {
                track(SHARED_EVENTS.QueueReordered, {
                  boardName: activeBoardRef.current?.boardType,
                  layoutId: activeBoardRef.current?.layoutId,
                  oldIndex: event.oldIndex,
                  newIndex: event.newIndex,
                  partyMode: true,
                  reorderedBy: 'peer',
                });
              }
              break;
          }
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

    // Follow board-path (angle) changes broadcast by other party members. The
    // angle is session-shared: when a peer changes it we update our own active
    // board's angle (which cascades to the climb list, play drawer, and the
    // re-grade effect). We don't switch the whole board — only the angle.
    const sessionUpdatesCleanup = wsClient.subscribe<{ sessionUpdates: SessionUpdateEvent }>(
      {
        query: SESSION_UPDATES_SUBSCRIPTION,
        variables: { sessionId },
      },
      {
        next: ({ data }) => {
          const event = data?.sessionUpdates;
          if (!event) return;
          if (sessionIdRef.current !== sessionId) return;

          // Live analytics push: flashes + flash/send/attempt grade split +
          // per-participant breakdown. Drives the in-session analytics view and
          // leaderboard without polling.
          if (event.__typename === 'SessionStatsUpdated') {
            setLiveStats({
              sessionId: event.sessionId ?? sessionId,
              totalSends: event.totalSends ?? 0,
              totalFlashes: event.totalFlashes ?? 0,
              totalAttempts: event.totalAttempts ?? 0,
              tickCount: event.tickCount ?? 0,
              participants: event.participants ?? [],
              gradeDistribution: event.gradeDistribution ?? [],
              boardTypes: event.boardTypes ?? [],
              hardestGrade: event.hardestGrade ?? null,
              durationMinutes: event.durationMinutes ?? null,
              goal: event.goal ?? null,
            });
            return;
          }

          if (event.__typename === 'SessionEnded') {
            if (locallyEndingSessionIdRef.current === sessionId) {
              suppressedRemoteEndSessionIdRef.current = sessionId;
              return;
            }
            void clearSessionRef.current();
            showToastRef.current(tRef.current('mobile.toast.sessionEnded'), 'success');
            return;
          }

          if (event.__typename === 'WallConfirmedClimb') {
            if (event.climbUuid) emitWallConfirm(event.climbUuid);
            return;
          }

          const runtimeEvent = toMobileSessionRuntimeEvent(event);
          if (runtimeEvent) {
            setSessionRuntimeState(
              (prev) => applySessionRuntimeEvent(prev, runtimeEvent) ?? createEmptySessionRuntimeState(),
            );
          }

          if (event.__typename !== 'SessionBoardPathChanged' || !event.boardPath) return;
          // Echo of our own change — we already applied it locally before
          // broadcasting. A null local participant id (peer event before our
          // JOIN_SESSION resolved) can't be the originator, so we apply it.
          if (event.changedByParticipantId && event.changedByParticipantId === participantIdRef.current) return;
          const parsed = parseBoardPath(event.boardPath);
          if (!parsed || parsed.angle == null) return;
          const nextAngle = parsed.angle;
          void (async () => {
            const stored = await getStoredActiveBoard();
            if (sessionIdRef.current !== sessionId) return;
            if (!stored || stored.angle === nextAngle) return;
            // Never override a fixed-angle board (mirrors handleAngleChange's
            // local guard) — a peer can't change an angle the board can't be
            // set to.
            if (stored.isAngleAdjustable === false) return;
            // Follow ONLY the angle, and only when the peer is on the SAME
            // board. A mixed-board session must not push a foreign angle (board
            // angle tables differ, e.g. MoonBoard only allows 25°/40°). Compare
            // the parsed board identity to our stored board before applying.
            if (
              parsed.boardName !== stored.boardType ||
              parsed.layoutId !== stored.layoutId ||
              parsed.sizeId !== stored.sizeId ||
              parsed.setIds !== stored.setIds
            ) {
              return;
            }
            await setActiveBoardRef.current({ ...stored, angle: nextAngle });
          })();
        },
        error: () => {},
        complete: () => {},
      },
    );

    return () => {
      cleanup();
      sessionUpdatesCleanup();
      unsubConnected();
      unsubClosed();
      unsubscribeRef.current = null;
      // Reset live analytics/presence on EVERY session change (not only on
      // teardown to null). A direct A→B switch (joinSession) flips sessionId
      // without an intermediate null, so without this the previous session's
      // liveStats/roster would leak into the joined session until B's first
      // push. The new session re-seeds the roster from its JOIN_SESSION response.
      setLiveStats(null);
      setSessionRuntimeState(createEmptySessionRuntimeState());
      setParticipantId(null);
      participantIdRef.current = null;
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
          track(SHARED_EVENTS.SessionStarted, {
            boardName: activeBoard.boardType,
            hasGoal: !!config?.goal,
            isDiscoverable: config?.discoverable ?? false,
          });
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
    // Strip the climb to ClimbInput fields — sending the raw search climb (with
    // created_at) makes the server reject the mutation and silently breaks queue
    // sync to peers. See toClimbInput.
    toQueueItemInput: (item) => ({ uuid: item.uuid, climb: toClimbInput(item.climb) }),
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

  // Broadcast the session's boardPath (angle/board) to party members. The
  // shared mutation already swallows transport errors and is a true no-op in
  // solo (never lazily creates a session), so callers can fire it freely.
  const setSessionBoardPath = useCallback((boardPath: string) => mutations.setSessionBoardPath(boardPath), [mutations]);
  const restoreQueueSnapshot = useCallback(
    (snapshot: {
      queue: ClimbQueueItem[];
      currentClimbQueueItem: ClimbQueueItem | null;
      playlistSuggestionSource: PlaylistSuggestionSource | null;
    }) => {
      dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: snapshot.queue, currentClimbQueueItem: snapshot.currentClimbQueueItem },
      });
      dispatch({ type: 'SET_PLAYLIST_SUGGESTION_SOURCE', payload: snapshot.playlistSuggestionSource });
      setPlaylistSuggestionSourceState(snapshot.playlistSuggestionSource);
    },
    [],
  );

  const takeControl = useCallback(
    async (item?: ClimbQueueItem | null, options?: TakeControlOptions) => {
      if (!sessionIdRef.current) {
        await mutations.takeControl(item);
        return;
      }

      const queueSnapshot = {
        queue: stateRef.current.queue,
        currentClimbQueueItem: stateRef.current.currentClimbQueueItem,
        playlistSuggestionSource: playlistSuggestionSourceRef.current,
      };
      const localParticipantId = participantIdRef.current;
      const plan = createTakeControlOptimisticPlan({
        isSessionActive: true,
        currentOperationId: wallControlOperationRef.current,
        localParticipantId,
        previousDriverParticipantId: sessionRuntimeStateRef.current.driverParticipantId,
        item,
        hasExplicitPlaylistSuggestionSource: Object.prototype.hasOwnProperty.call(
          options ?? {},
          'playlistSuggestionSource',
        ),
        explicitPlaylistSuggestionSource: options?.playlistSuggestionSource,
      });
      wallControlOperationRef.current = plan.operationId;

      const optimisticDriverParticipantId = plan.optimisticDriverParticipantId;
      if (optimisticDriverParticipantId != null) {
        setSessionRuntimeState((current) => ({ ...current, driverParticipantId: optimisticDriverParticipantId }));
      }
      if (plan.shouldUpdateCurrentClimb && item) {
        if (plan.playlistSuggestionSource !== undefined) {
          setPlaylistSuggestionSourceState(plan.playlistSuggestionSource);
        }
        dispatch({
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item,
            shouldAddToQueue: true,
            isServerEvent: false,
            ...(plan.playlistSuggestionSource === undefined
              ? {}
              : { playlistSuggestionSource: plan.playlistSuggestionSource }),
          },
        });
      }

      try {
        await mutations.takeControl(item);
      } catch (error) {
        if (
          shouldRollbackTakeControlQueue({
            currentOperationId: wallControlOperationRef.current,
            operationId: plan.operationId,
            itemUuid: item?.uuid,
            currentClimbQueueItemUuid: stateRef.current.currentClimbQueueItem?.uuid,
          })
        ) {
          restoreQueueSnapshot(queueSnapshot);
        }
        if (
          shouldRollbackTakeControlDriver({
            currentOperationId: wallControlOperationRef.current,
            operationId: plan.operationId,
            localParticipantId,
            currentDriverParticipantId: sessionRuntimeStateRef.current.driverParticipantId,
          })
        ) {
          setSessionRuntimeState((current) =>
            current.driverParticipantId === localParticipantId
              ? { ...current, driverParticipantId: plan.previousDriverParticipantId }
              : current,
          );
        }
        if (wallControlOperationRef.current === plan.operationId) {
          showToast(t('mobile.queue.actionFailed'), 'error');
        }
        throw error;
      }
    },
    [mutations, restoreQueueSnapshot, showToast, t],
  );

  const releaseControl = useCallback(async () => {
    if (!sessionIdRef.current) {
      await mutations.releaseControl();
      return;
    }

    const previousDriverParticipantId = sessionRuntimeStateRef.current.driverParticipantId;
    const localParticipantId = participantIdRef.current;
    const plan = createReleaseControlOptimisticPlan({
      currentOperationId: wallControlOperationRef.current,
      previousDriverParticipantId,
      localParticipantId,
    });
    if (plan.shouldOptimisticallyRelease) {
      wallControlOperationRef.current = plan.operationId;
      setSessionRuntimeState((current) => ({ ...current, driverParticipantId: null }));
    }
    try {
      await mutations.releaseControl();
    } catch (error) {
      if (
        shouldRollbackReleaseControlDriver({
          currentOperationId: wallControlOperationRef.current,
          operationId: plan.operationId,
          shouldOptimisticallyRelease: plan.shouldOptimisticallyRelease,
          currentDriverParticipantId: sessionRuntimeStateRef.current.driverParticipantId,
        })
      ) {
        setSessionRuntimeState((current) =>
          current.driverParticipantId === null
            ? { ...current, driverParticipantId: plan.previousDriverParticipantId }
            : current,
        );
      }
      if (
        shouldSurfaceReleaseControlFailure({
          currentOperationId: wallControlOperationRef.current,
          operationId: plan.operationId,
          shouldOptimisticallyRelease: plan.shouldOptimisticallyRelease,
        })
      ) {
        showToast(t('mobile.queue.actionFailed'), 'error');
      }
      throw error;
    }
  }, [mutations, showToast, t]);
  const confirmClimbOnWall = useCallback((climbUuid: string) => mutations.confirmClimbOnWall(climbUuid), [mutations]);
  const setSessionBoardSerial = useCallback((serial: string) => mutations.setSessionBoardSerial(serial), [mutations]);

  // Self-healing re-grade: a climb's difficulty/quality/sends are angle-specific
  // (stored per-angle server-side), but queue items carry the grade baked in for
  // the angle they were fetched at. Whenever the active angle differs from a
  // queued climb's display angle — the user changed the angle, or a server
  // FullSync re-staled the queue at the old angle — refetch that climb at the
  // live angle and patch it in. Local only: each client follows the angle and
  // re-grades its own queue, so nothing is sent to peers. Idempotent — after
  // patching, climb.angle === angle, so the effect no-ops on its own re-run.
  // Maps a climb uuid → the angle a re-grade fetch is currently in flight for.
  // Keyed by angle (not a plain Set) so a fetch already running for a STALE
  // angle doesn't block a fresh fetch when the angle changes again mid-flight —
  // otherwise that climb could strand at the old grade.
  const regradeInFlightRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!activeBoard) return undefined;
    const { boardType, layoutId, sizeId, setIds, angle } = activeBoard;
    const uuids = new Set<string>();
    const consider = (item: ClimbQueueItem | null | undefined) => {
      if (!item?.climb) return;
      // Re-grade when the display angle differs AND we aren't already fetching
      // this climb for the CURRENT angle (a fetch for a prior angle re-enqueues).
      if (item.climb.angle !== angle && regradeInFlightRef.current.get(item.climb.uuid) !== angle) {
        uuids.add(item.climb.uuid);
      }
    };
    state.queue.forEach(consider);
    consider(state.currentClimbQueueItem);
    if (uuids.size === 0) return undefined;

    const targetUuids = [...uuids];
    targetUuids.forEach((uuid) => regradeInFlightRef.current.set(uuid, angle));

    let cancelled = false;
    void (async () => {
      const client = getHttpClient();
      const patches = await Promise.all(
        targetUuids.map(async (climbUuid) => {
          try {
            const response = await client.request<GetClimbQueryResponse>(GET_CLIMB, {
              boardName: boardType,
              layoutId,
              sizeId,
              setIds,
              angle,
              climbUuid,
            });
            const climb = response.climb;
            if (!climb) return null;
            const patch: ClimbRegradePatch = {
              angle,
              difficulty: climb.difficulty,
              quality_average: climb.quality_average,
              ascensionist_count: climb.ascensionist_count,
              benchmark_difficulty: climb.benchmark_difficulty ?? null,
              difficulty_error: climb.difficulty_error,
            };
            return [climbUuid, patch] as const;
          } catch {
            return null;
          } finally {
            // Only clear our own marker — a newer run may have re-targeted this
            // uuid to a different angle, and must keep its in-flight claim.
            if (regradeInFlightRef.current.get(climbUuid) === angle) {
              regradeInFlightRef.current.delete(climbUuid);
            }
          }
        }),
      );
      if (cancelled) return;
      const grades: Record<string, ClimbRegradePatch> = {};
      for (const entry of patches) {
        if (entry) grades[entry[0]] = entry[1];
      }
      if (Object.keys(grades).length > 0) {
        dispatch({ type: 'REGRADE_CLIMBS', payload: { grades } });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.queue, state.currentClimbQueueItem, activeBoard]);

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
      track(SHARED_EVENTS.ClimbAddedToQueue, {
        climbUuid: item.climb.uuid,
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        addedFromTab: 'mobile',
        currentQueueLength: stateRef.current.queue.length + 1,
      });
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
      const removedItem = stateRef.current.queue.find((queueItem) => queueItem.uuid === uuid);
      // Same best-effort model as addToQueue: the reducer already removed the
      // item locally; the server mutation only syncs it to a party session (and
      // no-ops when there's none — it never lazily creates one just to remove).
      dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid } });
      track(SHARED_EVENTS.ClimbRemovedFromQueue, {
        climbUuid: removedItem?.climb.uuid ?? null,
        queueItemUuid: uuid,
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        removedBy: 'self',
      });
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
      track(SHARED_EVENTS.QueueReordered, {
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        oldIndex,
        newIndex,
        partyMode: sessionIdRef.current !== null,
        reorderedBy: 'self',
      });
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
    track(SHARED_EVENTS.QueueCleared, { layoutId: activeBoardRef.current?.layoutId, totalCount: itemsToRemove.length });
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
      track(SHARED_EVENTS.SetActiveClimb, {
        climbUuid: item.climb.uuid,
        layoutId: activeBoardRef.current?.layoutId,
        source: 'mobile',
      });
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
    sessionIdRef.current = null;
    setSessionId(null);
    dispatch({
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });
    setPlaylistSuggestionSourceState(null);
    await clearStoredSessionId();
  }, []);
  clearSessionRef.current = clearSession;

  const endSession = useCallback(async (): Promise<SessionSummary | null> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return null;

    try {
      locallyEndingSessionIdRef.current = currentSessionId;
      const response = await getHttpClient().request<EndSessionMutationResponse>(END_SESSION, {
        sessionId: currentSessionId,
      });
      await clearSession();
      locallyEndingSessionIdRef.current = null;
      suppressedRemoteEndSessionIdRef.current = null;
      track(SHARED_EVENTS.SessionEnded, { sessionId: currentSessionId });
      showToast(t('mobile.toast.sessionEnded'), 'success');
      return response.endSession;
    } catch {
      if (suppressedRemoteEndSessionIdRef.current === currentSessionId) {
        locallyEndingSessionIdRef.current = null;
        suppressedRemoteEndSessionIdRef.current = null;
        await clearSession();
        showToast(t('mobile.toast.sessionEnded'), 'success');
        return null;
      }
      locallyEndingSessionIdRef.current = null;
      showToast(t('mobile.queue.actionFailed'), 'error');
      return null;
    }
  }, [clearSession, showToast, t]);

  const joinSession = useCallback(
    async (sessionToJoin: string, opts: { boardPath: string; userBoard: UserBoard }) => {
      // Idempotent against double-tap / re-entrant deep links.
      if (sessionIdRef.current === sessionToJoin) return;
      // Switch the active board to the session's board FIRST (and persist it) so
      // the session effect's JOIN_SESSION reads the correct boardPath and the
      // whole tree (BLE wrapper, BoardProvider, climb list, play drawer) renders
      // on the joined board. Unlike startSession (which reads the active board to
      // build the new session's path), joinSession writes it from the session.
      await setActiveBoard(opts.userBoard);
      sessionIdRef.current = sessionToJoin;
      setSessionId(sessionToJoin);
      await setStoredSessionId(sessionToJoin);
    },
    [setActiveBoard],
  );

  const publishPlaybackState = useCallback(
    (input: PublishPlaybackStateInput) => mutations.publishPlaybackState(input),
    [mutations],
  );

  // Stable action bundle. Split out of contextValue so consumers that only need
  // to dispatch (the climb list's addToQueue) can subscribe via useQueueActions()
  // without re-rendering on every reducer `state` change. Every member is an
  // individually-stable useCallback, so this memo only ever recomputes if one of
  // them genuinely changes identity (it shouldn't, in practice).
  const actionsValue = useMemo<QueueActionsContextValue>(
    () => ({
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      clearSession,
      endSession,
      startSession: createSessionWithConfig,
      joinSession,
      setSessionBoardPath,
      takeControl,
      releaseControl,
      confirmClimbOnWall,
      setSessionBoardSerial,
      subscribeToQueueEvents,
      publishPlaybackState,
    }),
    [
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      clearSession,
      endSession,
      createSessionWithConfig,
      joinSession,
      setSessionBoardPath,
      takeControl,
      releaseControl,
      confirmClimbOnWall,
      setSessionBoardSerial,
      subscribeToQueueEvents,
      publishPlaybackState,
    ],
  );

  const contextValue = useMemo<QueueContextValue>(
    () => ({
      state,
      dispatch,
      sessionId,
      setSessionId,
      driverParticipantId,
      lastConnectedBoardSerial,
      participantId,
      ...actionsValue,
    }),
    [state, sessionId, driverParticipantId, lastConnectedBoardSerial, participantId, actionsValue],
  );

  // Active-climb selector: identity changes ONLY when the active climb uuid
  // changes (memoized on the uuid string), so highlight-only consumers like the
  // climb list don't re-render on unrelated queue mutations or party pushes.
  const activeClimbUuid = state.currentClimbQueueItem?.climb?.uuid ?? null;
  const activeClimbValue = useMemo<QueueActiveClimbContextValue>(() => ({ activeClimbUuid }), [activeClimbUuid]);

  // Presence-only selector: flips solely when a climb appears/disappears, so
  // bottom-chrome consumers (whole tab screens) don't re-render on climb-to-climb
  // navigation — only the climb-row highlight (useActiveClimbUuid) does.
  const hasActiveClimb = activeClimbUuid != null;
  const hasActiveClimbValue = useMemo<QueueHasActiveClimbContextValue>(() => ({ hasActiveClimb }), [hasActiveClimb]);

  // SessionId-only selector: identity changes only when a session starts/ends,
  // so structural readers (tab layout, board adapter, session screen) stop
  // re-rendering the navigation tree on every queue mutation.
  const sessionIdValue = useMemo<QueueSessionIdContextValue>(() => ({ sessionId }), [sessionId]);

  // Live analytics + presence: the ≤1/2s party push recreates only this small
  // value, re-rendering only SessionScreen + InSessionView.
  const liveStatsValue = useMemo<QueueLiveStatsContextValue>(
    () => ({ liveStats, sessionUsers }),
    [liveStats, sessionUsers],
  );

  const playlistSuggestionValue = useMemo<QueuePlaylistSuggestionContextValue>(
    () => ({ playlistSuggestionSource }),
    [playlistSuggestionSource],
  );

  const sessionControlValue = useMemo<QueueSessionControlContextValue>(
    () => ({
      sessionId,
      driverParticipantId,
      participantId,
      lastConnectedBoardSerial,
      takeControl,
      releaseControl,
      confirmClimbOnWall,
      setSessionBoardSerial,
    }),
    [
      sessionId,
      driverParticipantId,
      participantId,
      lastConnectedBoardSerial,
      takeControl,
      releaseControl,
      confirmClimbOnWall,
      setSessionBoardSerial,
    ],
  );

  return (
    <QueueSessionControlContext.Provider value={sessionControlValue}>
      <QueueSessionIdContext.Provider value={sessionIdValue}>
        <QueueLiveStatsContext.Provider value={liveStatsValue}>
          <QueueActionsContext.Provider value={actionsValue}>
            <QueuePlaylistSuggestionContext.Provider value={playlistSuggestionValue}>
              <QueueActiveClimbContext.Provider value={activeClimbValue}>
                <QueueHasActiveClimbContext.Provider value={hasActiveClimbValue}>
                  <QueueContext.Provider value={contextValue}>{children}</QueueContext.Provider>
                </QueueHasActiveClimbContext.Provider>
              </QueueActiveClimbContext.Provider>
            </QueuePlaylistSuggestionContext.Provider>
          </QueueActionsContext.Provider>
        </QueueLiveStatsContext.Provider>
      </QueueSessionIdContext.Provider>
    </QueueSessionControlContext.Provider>
  );
}
