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
  mapSubscriptionEnvelopeToAction,
  type RuntimeSessionState,
  type SubscriptionWireEnvelope,
} from '@boardsesh/queue-runtime';
import { useQueueMutations, type PublishPlaybackStateInput } from '@boardsesh/queue-react';
import type { SessionSummary, SubscriptionQueueEvent, SessionUser, UserBoard } from '@boardsesh/shared-schema';
import { execute, GraphQLOperationError, isRateLimitedExtension } from '@boardsesh/graphql-client';
import { buildBoardPath, parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { JOIN_SESSION, LEAVE_SESSION } from '@boardsesh/graphql/operations/queue-session';
import { getWsClient } from '../lib/graphql/ws-client';
import { getHttpClient } from '../lib/graphql/client';
import {
  QUEUE_UPDATES_SUBSCRIPTION,
  SESSION_UPDATES_SUBSCRIPTION,
  CREATE_SESSION,
  END_SESSION,
  GET_CLIMB,
  SESSION_STATUS,
  GET_SESSION_QUEUE_STATE,
  type CreateSessionMutationResponse,
  type EndSessionMutationResponse,
  type SessionUpdateEvent,
  type SessionLiveStatsEvent,
  type GetClimbQueryResponse,
  type SessionStatusQueryResponse,
  type GetSessionQueueStateQueryResponse,
} from '../lib/graphql/operations';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { getDeviceTimezone } from '../lib/device-timezone';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import { getStoredSessionId, setStoredSessionId, clearStoredSessionId } from '../lib/session-store';
import { getStoredQueueSnapshot, setStoredQueueSnapshot, clearStoredQueueSnapshot } from '../lib/queue-snapshot-store';
import { emitWallConfirm, findPreviousQueueItem, findNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../lib/queue-conversion';
import { toMobileSessionRuntimeEvent } from '../lib/session-runtime-event';
import { climbToQueueItem, toClimbInput } from '../lib/climb-to-queue-item';
import { track } from '../lib/analytics';
import { reportError, reportHandledError } from '../lib/error-reporting';
import { extractGraphqlMessage, isGraphqlRateLimitedError } from '../lib/graphql/extract-error-message';
import { useToast } from './toast-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';

export type StartSessionConfig = {
  name?: string;
  goal?: string;
  color?: string;
  discoverable?: boolean;
  isPermanent?: boolean;
};

const JOIN_SESSION_RETRY_BACKOFF_MS = [1_000, 2_500, 5_000] as const;

// A party-session queue/wall mutation that fails because the backend throttled
// it (RATE_LIMITED) is transient — the optimistic state already applied and a
// peer-resync or the next gesture reconciles. Show a specific, gentle "slow
// down" message rather than the alarming generic "Action failed" toast (which
// a beta tester read as "the connection fails every time we switch boulders",
// #2763). Any other failure keeps the generic toast.
function showQueueMutationErrorToast(
  error: unknown,
  t: (key: string) => string,
  showToast: (message: string, variant: 'error') => void,
): void {
  if (error instanceof GraphQLOperationError && isRateLimitedExtension(error.extensions)) {
    // Rate-limiting is expected user-pacing, not a bug — toast only, no report.
    showToast(t('mobile.queue.rateLimited'), 'error');
  } else {
    showToast(t('mobile.queue.actionFailed'), 'error');
    // These mutations are direct GraphQL-WS ops (@boardsesh/queue-react), so the
    // React Query MutationCache doesn't see them — report here instead.
    reportHandledError(error, { tags: { source: 'queue-mutation' } });
  }
}

type QueueContextValue = {
  state: QueueState;
  dispatch: React.Dispatch<QueueAction>;
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  /** Most recently published physical board serial for this session, if any. */
  lastConnectedBoardSerial: string | null;
  /** Our own participant id for the active session (marks "you" in rosters). */
  participantId: string | null;
  /**
   * Whether the session's current climb is confirmed lit on a physical wall by
   * any member. Flipped on by `WallConfirmedClimb` (a member relayed the climb
   * over BLE) and off by `WallDisconnected` (a member's BLE link dropped). Drives
   * the lightbulb's lit indicator; the current climb is never cleared by either.
   */
  isSessionWallLit: boolean;
  addToQueue: (item: ClimbQueueItem) => void;
  removeFromQueue: (uuid: string) => void;
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  clearQueue: () => void;
  /** Replace the entire queue (optimistic local UPDATE_QUEUE + best-effort party sync). */
  setQueue: (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => void;
  setCurrentClimb: (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => void;
  nextClimb: () => void;
  previousClimb: () => void;
  /**
   * Apply a widget Next/Previous navigation by absolute index. Dispatches the
   * current-climb change with the provided correlationId (so the racing
   * `CurrentClimbChanged` server echo is suppressed) WITHOUT sending a fresh JS
   * mutation — the native widget intent already sent the server mutation. Using
   * the absolute item (not a relative `nextClimb`) keeps this idempotent, so it
   * can't double-advance when the WebSocket echo lands before the Darwin event.
   * Mirrors web's `dispatchWidgetNavigation`.
   */
  dispatchWidgetNavigation: (item: ClimbQueueItem, correlationId: string) => void;
  /** Replace the playlist suggestion source that drives swipe-through climbs. */
  setPlaylistSuggestionSource: (source: PlaylistSuggestionSource | null) => void;
  /** Refresh the suggestion source in place (no-op unless it matches the active one). */
  refreshPlaylistSuggestionSource: (source: PlaylistSuggestionSource) => void;
  /**
   * Reset the active session locally. Pass `{ notifyServer: true }` on an
   * intentional leave (e.g. switching sessions) to emit LEAVE_SESSION so peers
   * see the departure immediately instead of after the disconnect grace timer.
   */
  clearSession: (options?: { notifyServer?: boolean }) => Promise<void>;
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
   * Broadcast that this phone successfully wrote a climb to the physical wall.
   * The local wall-confirm bus is handled by the Bluetooth provider; this
   * mutation notifies party peers through the session subscription.
   */
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
  /**
   * Broadcast that this phone's BLE link to the wall dropped so every member
   * turns the lightbulb off (the current climb is preserved). Best-effort;
   * a true no-op in solo (never creates a session).
   */
  reportWallDisconnect: () => Promise<void>;
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
 * - useQueueSessionControls(): session id, serial/wall controls, and the member-userId set for party surfaces.
 * - useQueueLiveStats(): high-frequency live stats and roster updates.
 * - useActiveClimbUuid(): row-level active-climb highlighting.
 * - useHasActiveClimb(): presence-only bottom chrome metrics.
 * - usePlaylistSuggestionSource(): playlist peek/suggestion navigation.
 */
type QueueSessionControlContextValue = Pick<
  QueueContextValue,
  | 'sessionId'
  | 'participantId'
  | 'lastConnectedBoardSerial'
  | 'isSessionWallLit'
  | 'confirmClimbOnWall'
  | 'reportWallDisconnect'
  | 'setSessionBoardSerial'
> & {
  /**
   * Stable DB user UUIDs of the current session's members (including me). Used to
   * id-match the board-presence holder against "someone in my session" so the
   * lightbulb lights only for a session member's BLE link, not any board holder.
   * Empty when solo. Memoized by the sorted-id set so the ≤1/2s party push doesn't
   * churn its identity.
   */
  sessionMemberUserIds: ReadonlySet<string>;
};

const QueueSessionControlContext = createContext<QueueSessionControlContextValue | null>(null);

/**
 * SessionId-only selector context. Its identity changes ONLY when the active
 * session id changes (session start / end / join — rare), never on queue
 * mutations or the ≤1/2s party pushes. Consumed by high-fanout *structural*
 * readers — the tab layout (which renders every tab inline), the board adapter,
 * and the session screen — so a queue change can't cascade a re-render through
 * the whole navigation tree. Narrower than QueueSessionControlContext, which
 * also churns on board-serial / wall-lit changes.
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
  | 'lastConnectedBoardSerial'
  | 'participantId'
  | 'isSessionWallLit'
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

/**
 * Returns the active playlist suggestion source, or null when no playlist
 * continuation is active. A missing context still throws: in-tree "no source"
 * is represented by `null`, while no provider means the hook was misused.
 */
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
  lastConnectedBoardSerial: null,
  boardPath: '',
});

// Stable empty Set so the no-session case never publishes a fresh identity.
const EMPTY_USER_ID_SET: ReadonlySet<string> = new Set<string>();

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(queueReducer, defaultSearchParams, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Live session analytics + presence. liveStats is pushed over `sessionUpdates`
  // (SessionStatsUpdated); the roster is seeded from JOIN_SESSION and kept
  // current via UserJoined/UserLeft/UserPresenceChanged.
  const [liveStats, setLiveStats] = useState<SessionLiveStatsEvent | null>(null);
  const [sessionRuntimeState, setSessionRuntimeState] =
    useState<MobileSessionRuntimeState>(createEmptySessionRuntimeState);
  const sessionUsers = sessionRuntimeState.users;
  const lastConnectedBoardSerial = sessionRuntimeState.lastConnectedBoardSerial;
  // Session-scoped "the current climb is lit on a wall" indicator. Flipped on by
  // a WallConfirmedClimb event (a member relayed the climb over BLE) and off by a
  // WallDisconnected event (a member's BLE link dropped). Never clears the
  // current climb — only the lit indicator. Drives the lightbulb's lit state for
  // members who aren't the one holding the BLE link.
  const [isSessionWallLit, setIsSessionWallLit] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  // Our own participant id, captured from the JOIN_SESSION response. Used to
  // suppress the echo of our own SessionBoardPathChanged broadcasts (the server
  // stamps `changedByParticipantId` with the originator's participant id).
  const participantIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // Single-flight guard for resyncQueueFromServer: a failed mutation in a party
  // session refetches the authoritative queue, but several deltas can fail in a
  // burst (e.g. clearQueue removes N items, the WS is down). Coalesce them into
  // one in-flight fetch so we don't hammer the server or thrash the reducer.
  const resyncInFlightRef = useRef(false);

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
          // Seed the live presence roster from the join response. The
          // UserJoined/UserLeft/UserPresenceChanged events that follow are
          // deltas; this is the initial snapshot of who's already in the session.
          setSessionRuntimeState({
            users: joined?.users ?? [],
            isLeader: joined?.isLeader ?? false,
            clientId: joined?.clientId ?? joined?.participantId ?? '',
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

  // Cold-start restore lives below, after restoreQueueSnapshot is defined —
  // it needs the snapshot helper for the solo-queue branch.

  // showToast and t aren't stable callbacks — capture via refs so the WS
  // subscription effect doesn't tear down & re-subscribe on locale change
  // (which would briefly miss in-flight peer events). coordinator and dispatch
  // are stable (useMemo([]) / useReducer respectively) so they can sit in the
  // dep array directly.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;
  const clearSessionRef = useRef<(options?: { notifyServer?: boolean }) => Promise<void>>(async () => {});
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
      setIsSessionWallLit(false);
      joinTracker.reset();
      return;
    }

    const wsClient = getWsClient();
    let disposed = false;
    let subscriptionStartToken = 0;
    let queueUpdatesCleanup: (() => void) | null = null;
    let sessionUpdatesCleanup: (() => void) | null = null;
    let joinRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let joinRetryCount = 0;

    const clearJoinRetryTimer = () => {
      if (!joinRetryTimer) return;
      clearTimeout(joinRetryTimer);
      joinRetryTimer = null;
    };

    const cleanupSubscriptions = () => {
      clearJoinRetryTimer();
      queueUpdatesCleanup?.();
      sessionUpdatesCleanup?.();
      queueUpdatesCleanup = null;
      sessionUpdatesCleanup = null;
      unsubscribeRef.current = null;
    };

    const logJoinFailure = (err: unknown) => {
      if (__DEV__) console.warn('[queue] joinSession failed', err);
    };

    const scheduleJoinRetry = (failedStartToken: number) => {
      const retryDelayMs =
        JOIN_SESSION_RETRY_BACKOFF_MS[Math.min(joinRetryCount, JOIN_SESSION_RETRY_BACKOFF_MS.length - 1)];
      joinRetryCount++;
      joinRetryTimer = setTimeout(() => {
        joinRetryTimer = null;
        if (disposed || failedStartToken !== subscriptionStartToken || sessionIdRef.current !== sessionId) return;
        void startJoinedSubscriptions();
      }, retryDelayMs);
    };

    const startJoinedSubscriptions = async () => {
      const currentStartToken = ++subscriptionStartToken;
      cleanupSubscriptions();

      try {
        await ensureJoined(sessionId);
      } catch (joinError) {
        if (disposed || currentStartToken !== subscriptionStartToken || sessionIdRef.current !== sessionId) return;
        logJoinFailure(joinError);
        if (joinRetryCount === 0) {
          showToastRef.current(tRef.current('mobile.queue.syncError'), 'error');
          reportHandledError(joinError, { tags: { source: 'queue-sync', op: 'join' } });
        }
        scheduleJoinRetry(currentStartToken);
        return;
      }

      if (disposed || currentStartToken !== subscriptionStartToken || sessionIdRef.current !== sessionId) return;
      joinRetryCount = 0;

      queueUpdatesCleanup = wsClient.subscribe<{ queueUpdates: QueueUpdateEvent }>(
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

      // Follow board-path (angle) changes broadcast by other party members. The
      // angle is session-shared: when a peer changes it we update our own active
      // board's angle (which cascades to the climb list, play drawer, and the
      // re-grade effect). We don't switch the whole board — only the angle.
      sessionUpdatesCleanup = wsClient.subscribe<{ sessionUpdates: SessionUpdateEvent }>(
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
              // A member relayed the current climb to a physical wall — light the
              // session lightbulb for everyone and replay the local wall-confirm
              // bus (drives the BLE provider's dedup + confirmation animations).
              setIsSessionWallLit(true);
              if (event.climbUuid) emitWallConfirm(event.climbUuid);
              return;
            }

            if (event.__typename === 'WallDisconnected') {
              // A member's BLE link to the wall dropped — turn the lightbulb off
              // for everyone. The current climb is intentionally preserved;
              // pressing the lightbulb re-asserts it. applySessionRuntimeEvent
              // treats this as a no-op on the durable roster (the lit state is a
              // UI concern owned here), so the runtime-event branch below skips it.
              setIsSessionWallLit(false);
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
            // Named-board hosts (`/b/{slug}`) broadcast a slug path the tuple
            // parser rejects. Follow the angle when we're on the SAME named board
            // (slug match) — the angle table differs per board, so never cross
            // boards (mirrors the tuple-identity guard below).
            const named = parseNamedBoardPath(event.boardPath);
            if (named) {
              if (named.angle == null) return;
              const nextNamedAngle = named.angle;
              void (async () => {
                const stored = await getStoredActiveBoard();
                if (sessionIdRef.current !== sessionId) return;
                if (!stored || stored.angle === nextNamedAngle) return;
                if (stored.isAngleAdjustable === false) return;
                if (!stored.slug || stored.slug !== named.slug) return;
                await setActiveBoardRef.current({ ...stored, angle: nextNamedAngle });
              })();
              return;
            }
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

      unsubscribeRef.current = cleanupSubscriptions;
    };

    // graphql-ws auto-reconnects, and every reconnect gives us a fresh
    // per-connection ConnectionContext on the backend. Tear down subscriptions
    // when the socket closes so they cannot auto-resubscribe before JOIN_SESSION
    // has updated that fresh context.
    const unsubClosed = wsClient.on('closed', () => {
      joinTracker.bumpEpoch();
      subscriptionStartToken++;
      joinRetryCount = 0;
      cleanupSubscriptions();
    });
    const unsubConnected = wsClient.on('connected', () => {
      void startJoinedSubscriptions();
    });

    void startJoinedSubscriptions();

    return () => {
      disposed = true;
      subscriptionStartToken++;
      cleanupSubscriptions();
      unsubConnected();
      unsubClosed();
      // Reset live analytics/presence on EVERY session change (not only on
      // teardown to null). A direct A→B switch (joinSession) flips sessionId
      // without an intermediate null, so without this the previous session's
      // liveStats/roster would leak into the joined session until B's first
      // push. The new session re-seeds the roster from its JOIN_SESSION response.
      setLiveStats(null);
      setSessionRuntimeState(createEmptySessionRuntimeState());
      setIsSessionWallLit(false);
      setParticipantId(null);
      participantIdRef.current = null;
      joinTracker.reset();
    };
  }, [sessionId, coordinator, ensureJoined, joinTracker]);

  // Server-side queue mutations live in @boardsesh/queue-react (shared with
  // web). The `ensureReady` seam resolves + joins the session before each
  // mutation; returning null makes the action a silent no-op. With no session
  // active every queue mutation is local-only — sessions are created ONLY by
  // the explicit Start button (createSessionWithConfig below) or an explicit
  // join, matching web. Optimistic local dispatch + correlation tracking stay
  // here; the shared hook only talks to the server and owns the
  // serialize-and-supersede coalescer for rapid swipes.
  const mutations = useQueueMutations<ClimbQueueItem>({
    getClient: () => getWsClient(),
    getSessionId: () => sessionIdRef.current,
    // Strip the climb to ClimbInput fields — sending the raw search climb (with
    // created_at) makes the server reject the mutation and silently breaks queue
    // sync to peers. See toClimbInput.
    toQueueItemInput: (item) => ({ uuid: item.uuid, climb: toClimbInput(item.climb) }),
    ensureReady: async (capturedSessionId) => {
      if (!capturedSessionId) return null;
      await ensureJoined(capturedSessionId);
      return capturedSessionId;
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

  // Explicit session creation — the Start button (PreSessionView) and nothing
  // else. Sessions are never created lazily: the solo queue lives locally
  // (queue-snapshot-store) until the user starts or joins one, matching web.
  const createSessionWithConfig = useCallback(
    async (config?: StartSessionConfig): Promise<string | null> => {
      if (sessionIdRef.current) return sessionIdRef.current;
      if (sessionCreationRef.current) return sessionCreationRef.current;

      const createPromise = (async () => {
        const activeBoard = await getStoredActiveBoard();
        if (!activeBoard) {
          // The Start button is gated on the React Query copy of the active board;
          // if the stored board is somehow missing, fail loudly so the user knows
          // to pick a board instead of tapping into a silent no-op.
          showToast(t('mobile.queue.noBoardSelected'), 'error');
          return null;
        }

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
          await setStoredSessionId(newId);
          // Seed the session with the locally-built queue BEFORE setSessionId
          // mounts the queueUpdates subscription — the subscription's FullSync
          // for an empty room would wipe the local queue via INITIAL_QUEUE_DATA.
          // SET_QUEUE is connection-scoped, so JOIN first (the subscription
          // effect's later eager ensureJoined hits the tracker cache).
          const { queue, currentClimbQueueItem } = stateRef.current;
          if (queue.length > 0 || currentClimbQueueItem) {
            try {
              await ensureJoined(newId);
              await mutations.setQueue(queue, currentClimbQueueItem ?? undefined);
              // Queue ownership moved to the session — drop the local snapshot
              // so a stale copy can't resurrect after the session ends. Only on
              // a successful seed: if seeding failed, the snapshot is the sole
              // surviving copy and a relaunch can still recover the queue.
              await clearStoredQueueSnapshot();
            } catch (seedError) {
              if (__DEV__) console.warn('[queue] session queue seed failed', seedError);
              reportHandledError(seedError, { tags: { source: 'startSessionSeed' } });
            }
          }
          setSessionId(newId);
          track(SHARED_EVENTS.SessionStarted, {
            boardName: activeBoard.boardType,
            hasGoal: !!config?.goal,
            isDiscoverable: config?.discoverable ?? false,
          });
          return newId;
        } catch (error) {
          if (isGraphqlRateLimitedError(error)) {
            showToast(t('mobile.queue.rateLimited'), 'error');
            return null;
          }
          // Production masks the GraphQL message to "Unexpected error", but the
          // graphql-request ClientError still carries the HTTP status — so error
          // reporting can distinguish network-down from a 4xx/5xx from a masked
          // server throw. Capture it with boardPath context; the backend captures
          // the unmasked cause for the same request (see createSession resolver).
          const httpStatus =
            error && typeof error === 'object' && 'response' in error
              ? ((error as { response?: { status?: number } }).response?.status ?? null)
              : null;
          reportError(error, {
            tags: { source: 'createSession' },
            extra: { boardPath, httpStatus, discoverable: config?.discoverable ?? false },
          });
          // Against a local backend (dev) errors aren't masked, so surface the
          // real server message to speed up diagnosis; shipped builds keep the
          // friendly fallback.
          const devMessage = __DEV__ ? extractGraphqlMessage(error) : null;
          showToast(devMessage ?? t('mobile.queue.sessionCreateError'), 'error');
          return null;
        } finally {
          sessionCreationRef.current = null;
        }
      })();

      sessionCreationRef.current = createPromise;
      return createPromise;
    },
    [ensureJoined, mutations, showToast, t],
  );

  // Cold-start restore, explicit-session first: a stored session id (persisted
  // only on explicit start/join) is verified and rejoined; otherwise the local
  // solo queue snapshot hydrates the reducer. The gate flag below keeps the
  // save effect from clobbering a stored snapshot with the initial empty state.
  const snapshotHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const hydrateLocalSnapshot = async () => {
      const snapshot = await getStoredQueueSnapshot();
      if (cancelled || !snapshot) return;
      // The user may have started acting — or a session may have appeared —
      // before the async load resolved; never clobber newer state.
      if (sessionIdRef.current !== null) return;
      if (stateRef.current.queue.length > 0 || stateRef.current.currentClimbQueueItem) return;
      restoreQueueSnapshot(snapshot);
    };
    void getStoredSessionId()
      .then(async (storedId) => {
        if (__DEV__) {
          console.info(`[session] restored from store: ${storedId ?? '(none)'}`);
        }
        if (!storedId) {
          await hydrateLocalSnapshot();
          return;
        }
        try {
          // Verify the stored session is still alive before rejoining. Without
          // this, JOIN_SESSION recreates a server-ended room as an empty zombie
          // and we land in InSessionView with no peers (#2683). sessionStatus
          // reads the durable session row, NOT the presence-gated `session`
          // query — that one returns null for any empty session, so it can't
          // tell an ended session apart from a dormant-but-active solo session.
          // null means the session row no longer exists; anything but 'active'
          // means drop the stored id.
          const { sessionStatus } = await getHttpClient().request<SessionStatusQueryResponse>(SESSION_STATUS, {
            sessionId: storedId,
          });
          if (cancelled) return;
          if (sessionStatus !== 'active') {
            if (__DEV__) {
              console.info(`[session] stored session ${storedId} ended/missing; clearing`);
            }
            await clearStoredSessionId();
            await hydrateLocalSnapshot();
            return;
          }
          setSessionId(storedId);
        } catch (err) {
          // graphql-request's ClientError always carries `response`; a genuine
          // network failure (fetch reject) doesn't — same structural check as
          // createSessionWithConfig's error handling above.
          const isServerResponse = !!err && typeof err === 'object' && 'response' in err;
          if (isServerResponse) {
            // The backend answered but the query failed (version skew — an
            // older backend without sessionStatus — or a masked 500). Don't
            // restore: a zombie session would put the whole app "in session".
            // Don't clear either: the id may verify fine once backend/app
            // versions align, so the next launch retries.
            reportError(err, { tags: { source: 'sessionRestore' } });
            await hydrateLocalSnapshot();
            return;
          }
          // Offline cold start: can't verify the session status, so restore
          // optimistically so the queue still comes back. A genuinely-dead
          // session stays escapable via End Session.
          if (__DEV__) {
            console.warn('[session] status check failed; restoring optimistically', err);
          }
          if (!cancelled) setSessionId(storedId);
        }
      })
      .finally(() => {
        if (!cancelled) snapshotHydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [restoreQueueSnapshot]);

  // Persist the SOLO queue across launches. Only while no session is active —
  // a session's queue is server-owned (the rejoin FullSync restores it) — and
  // only after the cold-start hydrate settles. Writing the empty state doubles
  // as the clear when the user empties the queue or a session teardown resets
  // it; the debounce coalesces mutation bursts (swipes, clear-queue removals).
  useEffect(() => {
    if (!snapshotHydratedRef.current || sessionId !== null) return undefined;
    const persistTimeout = setTimeout(() => {
      void setStoredQueueSnapshot({
        queue: state.queue,
        currentClimbQueueItem: state.currentClimbQueueItem,
        playlistSuggestionSource,
      });
    }, 500);
    return () => clearTimeout(persistTimeout);
  }, [state.queue, state.currentClimbQueueItem, playlistSuggestionSource, sessionId]);

  // Reconcile the local queue against the server's authoritative snapshot after
  // a party-session mutation fails. The optimistic reducer delta already applied
  // locally, so on failure (a 4xx, a dropped WS frame) this client's queue would
  // silently diverge from peers until the next reconnect FullSync. Refetch the
  // session's queueState over HTTP and replace state with INITIAL_QUEUE_DATA.
  // Single-flight (a burst of failed deltas coalesces into one fetch) and a true
  // no-op in solo (no session → nothing authoritative to reconcile against, the
  // local queue IS the source of truth). The fetch itself failing is swallowed:
  // we tried, the reducer keeps the optimistic state, and the next successful
  // mutation or reconnect FullSync reconciles. Returns whether a refresh ran.
  const resyncQueueFromServer = useCallback(async (): Promise<boolean> => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return false;
    if (resyncInFlightRef.current) return false;
    resyncInFlightRef.current = true;
    try {
      const response = await getHttpClient().request<GetSessionQueueStateQueryResponse>(GET_SESSION_QUEUE_STATE, {
        sessionId: activeSessionId,
      });
      // The session may have ended (or we switched sessions) while the fetch was
      // in flight — only apply when it's still the active one.
      if (sessionIdRef.current !== activeSessionId) return false;
      const queueState = response.session?.queueState;
      if (!queueState) return false;
      dispatch({
        type: 'INITIAL_QUEUE_DATA',
        payload: {
          queue: queueState.queue.map(toClimbQueueItem),
          currentClimbQueueItem: queueState.currentClimbQueueItem
            ? toClimbQueueItem(queueState.currentClimbQueueItem)
            : null,
        },
      });
      return true;
    } catch (error) {
      if (__DEV__) console.warn('[queue] resyncQueueFromServer failed', error);
      reportHandledError(error, { tags: { source: 'queue-sync', op: 'resync' } });
      return false;
    } finally {
      resyncInFlightRef.current = false;
    }
  }, []);
  const resyncQueueFromServerRef = useRef(resyncQueueFromServer);
  resyncQueueFromServerRef.current = resyncQueueFromServer;

  // After a queue mutation fails in a party session, reconcile against the
  // server and tell the user their queue was refreshed. In solo (no session)
  // the local queue is authoritative, so keep the existing best-effort
  // behaviour: dev-log only, no resync, no toast.
  const resyncQueueAfterMutationFailure = useCallback(async () => {
    if (!sessionIdRef.current) return;
    const refreshed = await resyncQueueFromServerRef.current();
    if (refreshed) showToast(t('mobile.queue.outOfSyncRefreshed'), 'error');
  }, [showToast, t]);

  const confirmClimbOnWall = useCallback((climbUuid: string) => mutations.confirmClimbOnWall(climbUuid), [mutations]);
  const setSessionBoardSerial = useCallback((serial: string) => mutations.setSessionBoardSerial(serial), [mutations]);
  // Broadcast that THIS phone's BLE link to the wall dropped. The shared mutation
  // swallows transport errors and is a true no-op in solo (never creates a
  // session), so the BLE provider can fire it on every drop. Locally, our own
  // WallDisconnected echo flips the lightbulb off through the subscription
  // handler — no need to set isSessionWallLit here.
  const reportWallDisconnect = useCallback(() => mutations.reportWallDisconnect(), [mutations]);

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
    // Also re-grade the single displayed playlist peek (the next-up suggestion
    // shown at the queue tail). It lives in playlistSuggestionSource.climbs —
    // NOT in state.queue — so the queue-only pass above never touches it, and
    // the bar/drawer would keep showing the activation-angle grade until the
    // peek is committed. Only the next-up climb is ever displayed, so re-grade
    // that one alone; re-grading the whole source could be hundreds of climbs.
    const peekItem = findNextQueueItemWithSuggestions(
      state.queue,
      state.currentClimbQueueItem,
      playlistSuggestionSourceRef.current,
    );
    if (peekItem && isPlaylistPeekQueueItemUuid(peekItem.uuid)) consider(peekItem);
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
        // REGRADE_CLIMBS only patches the reducer's queue + current item. The
        // displayed peek lives in the provider-state suggestion source, so patch
        // its climbs here too (same patch map) — otherwise the next-up grade pill
        // keeps the old angle until the peek is committed. Idempotent: skips
        // climbs already at the live angle, and preserves the prev reference when
        // nothing changes so this never churns the source state.
        setPlaylistSuggestionSourceState((prev) => {
          if (!prev) return prev;
          let changed = false;
          const climbs = prev.climbs.map((climb) => {
            const patch = grades[climb.uuid];
            if (!patch || climb.angle === patch.angle) return climb;
            changed = true;
            return { ...climb, ...patch };
          });
          return changed ? { ...prev, climbs } : prev;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.queue, state.currentClimbQueueItem, activeBoard, playlistSuggestionSource]);

  // The reducer raises `needsResync` when it filters corrupted (null) items out
  // of a server FullSync/UPDATE_QUEUE — the local queue is now known-stale.
  // Mirror web (use-queue-event-subscription): in a party session, clear the
  // flag and refetch the authoritative snapshot. No toast — this is silent
  // corruption recovery, not a user-action failure.
  useEffect(() => {
    if (!state.needsResync || !sessionIdRef.current) return;
    dispatch({ type: 'CLEAR_RESYNC_FLAG' });
    void resyncQueueFromServerRef.current();
  }, [state.needsResync]);

  const addToQueue = useCallback(
    (item: ClimbQueueItem) => {
      // Optimistic local dispatch is the source of truth for the user's queue.
      // The server echoes this item via the WS subscription, but
      // DELTA_ADD_QUEUE_ITEM dedupes by uuid so the echo is a no-op. The shared
      // mutation only SYNCs the add to an existing session (solo is local-only —
      // it never creates one). That sync is best-effort: a solo user with no
      // session, an offline phone, or a transient WS error must NOT see "Action
      // failed" when the local queue is already correct. Dev-log only.
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
        // In a party session the add never reached peers — reconcile against the
        // server so this client doesn't silently diverge. Solo is a true no-op.
        void resyncQueueAfterMutationFailure();
      });
      // Surface the "Climb added to queue · Open" snackbar for every add path.
      showQueueAddedSnackbar();
    },
    [mutations, resyncQueueAfterMutationFailure, showQueueAddedSnackbar],
  );

  const removeFromQueue = useCallback(
    (uuid: string) => {
      const removedItem = stateRef.current.queue.find((queueItem) => queueItem.uuid === uuid);
      // Same best-effort model as addToQueue: the reducer already removed the
      // item locally; the server mutation only syncs it to an existing session
      // (and no-ops when there's none).
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
        // The remove never reached peers in a party session — reconcile so the
        // dropped item doesn't linger on peers (or come back here). Solo no-ops.
        void resyncQueueAfterMutationFailure();
      });
    },
    [mutations, resyncQueueAfterMutationFailure],
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
        showQueueMutationErrorToast(error, t, showToast);
      });
    },
    [mutations, showToast, t],
  );

  const clearQueue = useCallback(() => {
    const itemsToRemove = stateRef.current.queue;
    dispatch({ type: 'CLEAR_QUEUE' });
    track(SHARED_EVENTS.QueueCleared, { layoutId: activeBoardRef.current?.layoutId, totalCount: itemsToRemove.length });
    setPlaylistSuggestionSourceState(null);
    // If any per-item remove fails in a party session, the cleared items may
    // still live on peers — reconcile once against the server (single-flight
    // coalesces the burst) and tell the user we refreshed. Solo: the local
    // clear is authoritative, so resync no-ops and no toast fires.
    void Promise.allSettled(itemsToRemove.map((item) => mutations.removeQueueItem(item.uuid))).then((results) => {
      if (results.some((result) => result.status === 'rejected')) {
        void resyncQueueAfterMutationFailure();
      }
    });
  }, [mutations, resyncQueueAfterMutationFailure]);

  // Replace the whole queue in one shot: optimistic local UPDATE_QUEUE (the
  // source of truth for the user's queue) + a best-effort SET_QUEUE sync that
  // no-ops in solo and broadcasts to party peers when a session exists. Same
  // best-effort model as addToQueue — a sync failure leaves the local queue
  // correct, so it must not toast.
  const setQueue = useCallback(
    (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => {
      dispatch({ type: 'UPDATE_QUEUE', payload: { queue, currentClimbQueueItem: currentClimbQueueItem ?? null } });
      mutations.setQueue(queue, currentClimbQueueItem ?? undefined).catch((error) => {
        if (__DEV__) console.warn('[queue] setQueue sync failed', error);
      });
    },
    [mutations],
  );

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
        // In a party session the current-climb change never reached peers —
        // reconcile against the server (and toast that we refreshed) so this
        // client's current climb can't silently diverge. Solo keeps the prior
        // best-effort "Action failed" toast (there's no server to reconcile).
        if (sessionIdRef.current) {
          void resyncQueueAfterMutationFailure();
        } else {
          showToast(t('mobile.queue.actionFailed'), 'error');
        }
      });
    },
    [coordinator, mutations, resyncQueueAfterMutationFailure, showToast, t],
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

  // Optimistic dispatch for widget Next/Previous taps. The native widget intent
  // already sent the server mutation (HTTP /api/widget/navigate or the WS
  // fallback), so we only update the local reducer with the absolute item and
  // register the correlationId for echo suppression — no fresh JS mutation, and
  // no relative advance that could double-step against the racing broadcast.
  const dispatchWidgetNavigation = useCallback((item: ClimbQueueItem, correlationId: string) => {
    dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue: false, correlationId },
    });
  }, []);

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

  const clearSession = useCallback(async (options?: { notifyServer?: boolean }) => {
    // When the user intentionally leaves a session (switching into another via
    // the join-confirm dialog), tell the backend so peers see them leave NOW —
    // the driver/presence release shouldn't wait on the 60s disconnect grace
    // timer. Best-effort and BEFORE we reset local state, so the WS registration
    // for the old session is still alive: a failed/timed-out leave degrades to
    // the prior disconnect-grace behavior. Default false keeps every other
    // caller (remote SessionEnded, endSession) unchanged. Mirrors web's
    // sendLeaveOnCleanup in use-session-lifecycle.ts.
    if (options?.notifyServer && sessionIdRef.current) {
      try {
        await execute(getWsClient(), { query: LEAVE_SESSION }, 5000);
      } catch (error) {
        if (__DEV__) console.warn('[queue] leaveSession on switch failed', error);
      }
    }
    // A resync fetch that never settles (hung connection) would leave the
    // single-flight guard stuck true; a mounted provider carries that across a
    // session switch and would block every future resync. Reset at the teardown
    // boundary so the next session always starts clean.
    resyncInFlightRef.current = false;
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
        // Device IANA zone so the backend can export wall-clock local times
        // to platforms like Strava.
        timezone: getDeviceTimezone(),
      });
      await clearSession();
      locallyEndingSessionIdRef.current = null;
      suppressedRemoteEndSessionIdRef.current = null;
      track(SHARED_EVENTS.SessionEnded, { sessionId: currentSessionId });
      showToast(t('mobile.toast.sessionEnded'), 'success');
      return response.endSession;
    } catch {
      const remoteEndAlreadyApplied = suppressedRemoteEndSessionIdRef.current === currentSessionId;
      locallyEndingSessionIdRef.current = null;
      suppressedRemoteEndSessionIdRef.current = null;
      await clearSession();
      if (remoteEndAlreadyApplied) {
        showToast(t('mobile.toast.sessionEnded'), 'success');
      } else {
        showToast(t('mobile.queue.actionFailed'), 'error');
      }
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
      // The session's FullSync replaces the local queue — drop the solo
      // snapshot so a stale copy can't resurrect on a later cold start.
      await clearStoredQueueSnapshot();
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
      setQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      dispatchWidgetNavigation,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      clearSession,
      endSession,
      startSession: createSessionWithConfig,
      joinSession,
      setSessionBoardPath,
      confirmClimbOnWall,
      reportWallDisconnect,
      setSessionBoardSerial,
      subscribeToQueueEvents,
      publishPlaybackState,
    }),
    [
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      setQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      dispatchWidgetNavigation,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      clearSession,
      endSession,
      createSessionWithConfig,
      joinSession,
      setSessionBoardPath,
      confirmClimbOnWall,
      reportWallDisconnect,
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
      lastConnectedBoardSerial,
      participantId,
      isSessionWallLit,
      ...actionsValue,
    }),
    [state, sessionId, lastConnectedBoardSerial, participantId, isSessionWallLit, actionsValue],
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

  // The logged-in member userIds (anonymous members have no userId to match, so
  // they're filtered out), used to id-match the board-presence holder. `sessionUsers`
  // gets a fresh array identity on every ≤1/2s SessionStatsUpdated push even when the
  // roster is unchanged, so we hold the Set in a ref and keep its identity stable by
  // content equality: a new Set is published only when the membership actually
  // changes, so a stats-only push doesn't churn the session-control value (and
  // re-light the bulbs that read it). Content equality also avoids any
  // string-signature delimiter ambiguity.
  const sessionMemberUserIdsRef = useRef<ReadonlySet<string>>(EMPTY_USER_ID_SET);
  const sessionMemberUserIds = useMemo<ReadonlySet<string>>(() => {
    const next = new Set(sessionUsers.map((user) => user.userId).filter((userId): userId is string => userId != null));
    const prev = sessionMemberUserIdsRef.current;
    const unchanged = prev.size === next.size && [...next].every((userId) => prev.has(userId));
    if (unchanged) return prev;
    sessionMemberUserIdsRef.current = next;
    return next;
  }, [sessionUsers]);

  const sessionControlValue = useMemo<QueueSessionControlContextValue>(
    () => ({
      sessionId,
      participantId,
      lastConnectedBoardSerial,
      isSessionWallLit,
      sessionMemberUserIds,
      confirmClimbOnWall,
      reportWallDisconnect,
      setSessionBoardSerial,
    }),
    [
      sessionId,
      participantId,
      lastConnectedBoardSerial,
      isSessionWallLit,
      sessionMemberUserIds,
      confirmClimbOnWall,
      reportWallDisconnect,
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
