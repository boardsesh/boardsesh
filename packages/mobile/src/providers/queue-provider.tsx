import type { WidgetMirrorEvent } from '../../modules/live-activity/src/index';
import {
  useReducer,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  queueReducer,
  initialState,
  createQueueSyncCoordinator,
  generateClientId,
  playlistSuggestionSourceMatches,
  samePlaylistTrackResume,
  withPlaylistTrackResume,
  getQueueBoardKey,
  isPlaylistPeekQueueItemUuid,
  decideAdd,
  deriveAcceptedConfigs,
  isClimbOnReachableBoard,
  planPlayNext,
  playNextInsertPosition,
  MAX_SYNCED_QUEUE_ITEMS,
  clampQueueAroundCurrent,
} from '@boardsesh/queue';
import type {
  Climb,
  ClimbAuthoredPatch,
  QueueSearchParams,
  ClimbQueueItem,
  PlaylistSuggestionSource,
  PlaylistTrackResume,
  QueueAddPlacement,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import {
  countDistinctSessionUsers,
  countSessionPeers,
  createJoinSessionTracker,
  type QueueSyncGate,
} from '@boardsesh/queue-runtime';
import { useQueueMutations, type PublishPlaybackStateInput } from '@boardsesh/queue-react';
import type { QueueItemAttribution } from '@boardsesh/queue-react/queue-item-input';
import type { PlaybackStateChangedEvent, SessionUser } from '@boardsesh/shared-schema';
import { execute, isNotInSessionError, isRateLimitedError, isTransportClosedError } from '@boardsesh/graphql-client';
import {
  classifyClimbBoardCompatibility,
  toBoardName,
  type ActiveBoardForCompatibility,
} from '@boardsesh/board-config';
import { buildSessionBoardPath } from '../lib/boards/session-board-path';
import { SHARED_EVENTS, boardTypeProperty } from '@boardsesh/analytics';
import { JOIN_SESSION, UPDATE_USERNAME } from '@boardsesh/graphql/operations/queue-session';
import { getWsClient } from '../lib/graphql/ws-client';
import { subscribeWsConnectionEnded } from '../lib/graphql/ws-client-lifecycle';
import { getHttpClient } from '../lib/graphql/client';
import { sanitizeQueueSnapshot } from '../lib/queue-privacy';
import { invalidateStoredQueueSnapshot } from '../lib/queue-snapshot-store';
import { restoreRemovedQueueItems, type QueueContentSnapshot } from '../lib/queue-undo';
import {
  getPrivacyCredentialGeneration,
  getPrivacyRevocationGeneration,
  subscribeToPrivacyRevocations,
} from '../lib/privacy/privacy-cache';
import {
  GET_SESSION_QUEUE_STATE,
  type SessionLiveStatsEvent,
  type GetSessionQueueStateQueryResponse,
} from '../lib/graphql/operations';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import {
  anchoredSuggestionSource,
  resolveUpNextCommitResume,
  selectPreviousQueueItemWithSuggestions,
  selectNextQueueItemWithSuggestions,
  shouldDefaultToBrowse,
} from '@boardsesh/play-view';
import { useSharedSessionBrowseEnabled } from './feature-flags-provider';
import { useReachableBoardKeys } from './queue/use-reachable-board-keys';
import { toClimbQueueItem } from '../lib/queue-conversion';
import { getPlaylistRenderBoardTarget } from '../lib/playlists/playlist-climb-render-board';
import { resolveCommittableQueueItem, toQueueItemWireInput, isClimbResolved } from '../lib/climb-to-queue-item';
import { track, registerRenderSuperProperties } from '../lib/analytics';
import {
  requestedBoardRenderMode,
  resolveEffectiveRenderSettings,
  useBoardRenderSettings,
} from '../lib/board-render-settings';
import {
  getBoardseshRendererSupport,
  getBoardseshSupportRevision,
  subscribeToBoardseshSupport,
} from '../hooks/boardsesh-renderer-support';
import { reportHandledError } from '../lib/error-reporting';
import { useAuthTransportRevision } from '../lib/auth-transport-revision';
import { useToast } from './toast-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';
import { usePartyProfile } from './party-profile-provider';
import {
  QueueContext,
  QueueSessionControlContext,
  QueueSessionIdContext,
  QueueLiveStatsContext,
  QueueSharedSessionContext,
  QueueActiveClimbContext,
  QueueHasActiveClimbContext,
  QueueDataContext,
  QueueActionsContext,
  QueuePlaylistSuggestionContext,
  type QueueContextValue,
  type QueueSessionControlContextValue,
  type QueueSessionIdContextValue,
  type QueueLiveStatsContextValue,
  type QueueSharedSessionContextValue,
  type QueueActiveClimbContextValue,
  type QueueHasActiveClimbContextValue,
  type QueueDataContextValue,
  type QueueActionsContextValue,
  type QueuePlaylistSuggestionContextValue,
  type QueueReorderSource,
  type WidgetNavigationOptions,
} from './queue/queue-contexts';
import { createBoardFeedSuggestionSource } from '../lib/playlists/board-feed-suggestion-source';
import { createBoardSuggestionCompatibilityCache } from './queue/board-suggestion-compatibility-cache';
import { useCrossBoardAddGate } from './queue/use-cross-board-add-gate';
import { useQueueRegrade } from './queue/use-queue-regrade';
import { useQueueResolveClimbs } from './queue/use-queue-resolve-climbs';
import { useQueueClimbReads } from './queue/use-queue-climb-reads';
import { useQueuePersistence } from './queue/use-queue-persistence';
import { useSessionCommands } from './queue/use-session-commands';
import {
  useSessionRealtime,
  createEmptySessionRuntimeState,
  type MobileSessionRuntimeState,
} from './queue/use-session-realtime';

// Narrow subscription hooks moved to ./queue/queue-contexts; re-exported here so
// the `providers/queue-provider` import path (18 call sites) stays unchanged.
export {
  useQueue,
  useQueueSessionControls,
  useQueueSessionId,
  useQueueLiveStats,
  useIsSharedSession,
  useIsCrewSession,
  useActiveClimbUuid,
  useHasActiveClimb,
  useQueueData,
  useQueueActions,
  usePlaylistSuggestionSource,
} from './queue/queue-contexts';
export type { StartSessionConfig, QueueReorderSource } from './queue/queue-contexts';

/**
 * The board identity the compatibility helpers need, or undefined when we can't
 * name the active board (an unrecognised `boardType`, or none picked yet).
 *
 * Identity only — board name + layout. A same-layout different-size climb still
 * renders on its own board, so neither the add gate nor the swipe skip should
 * act on it; hold-id and size containment stay in `canAddClimbToBoard`.
 * `undefined` fails open everywhere it is used.
 */
function toActiveBoardCompatibilityConfig(
  activeBoard: { boardType: string; layoutId: number } | null | undefined,
): ActiveBoardForCompatibility | undefined {
  if (!activeBoard) return undefined;
  const activeBoardName = toBoardName(activeBoard.boardType);
  return activeBoardName ? { boardName: activeBoardName, layoutId: activeBoard.layoutId } : undefined;
}

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
  // Classify via the shared `isRateLimitedError` so every caller agrees on what
  // counts as a rate limit. It also catches the nested-`graphqlErrors` and
  // legacy message-only shapes that a bare `extensions.code` check misses, so a
  // pre-#2777 server still gets the gentle toast instead of "Action failed".
  if (isRateLimitedError(error)) {
    // Rate-limiting is expected user-pacing, not a bug — toast only, no report.
    showToast(t('mobile.queue.rateLimited'), 'error');
  } else {
    showToast(t('mobile.queue.actionFailed'), 'error');
    // These mutations are direct GraphQL-WS ops (@boardsesh/queue-react), so the
    // React Query MutationCache doesn't see them — report here instead.
    reportHandledError(error, { tags: { source: 'queue-mutation' } });
  }
}

const defaultSearchParams: QueueSearchParams = {};

// Stable empty Set so the no-session case never publishes a fresh identity.
const EMPTY_USER_ID_SET: ReadonlySet<string> = new Set<string>();

type QueueMutationOrigin = {
  generation: number;
  sessionId: string | null;
  authenticatedUserId: string | null;
};

type QueueResyncFlight = { pending: boolean };

function queueMutationOriginKey(origin: QueueMutationOrigin): string {
  return JSON.stringify([origin.generation, origin.sessionId, origin.authenticatedUserId]);
}

// A setCurrentClimb that never reached the session. Either the server refused
// it because the connection it arrived on had not re-joined yet (after a socket
// drop graphql-ws re-sends an in-flight mutation on the fresh socket, and it can
// beat that socket's JOIN_SESSION), or graphql-ws gave up on the socket before
// an answer came. Neither says the crew's wall disagrees with this phone's: the
// move just has not landed. A re-send waits for the live stream's FullSync to
// show that nothing happened in the session since this phone last heard from it
// (same sequence, still on a climb it moved off), so a move that did land and
// was then undone by a crewmate, or a crewmate's newer move, is not overwritten.
function moveMissedTheSession(error: unknown): boolean {
  return isNotInSessionError(error) || isTransportClosedError(error);
}

/** One failed setCurrentClimb, as `handleSetCurrentClimbFailure` needs it. */
type SetCurrentClimbFailure = {
  item: ClimbQueueItem;
  shouldAddToQueue: boolean;
  correlationId: string;
  /** The account, room and queue generation the send was aimed at. */
  origin: QueueMutationOrigin;
  /** The server sequence this phone had applied when the move was sent. */
  sentAtSequence: number | undefined;
  /** Sent from the coalescer's drain loop: its caller's promise had long resolved. */
  drained: boolean;
};

/** Where a setCurrentClimb send was aimed, kept by correlation id. */
type MoveSend = Pick<SetCurrentClimbFailure, 'origin' | 'sentAtSequence'>;

/** Sends whose origin a drained failure may still need; older ones are long settled. */
const MAX_TRACKED_MOVE_SENDS = 16;

/**
 * How long a move that missed the session waits for the live snapshot that
 * releases its re-send. A reconnect normally delivers it in about a second;
 * past this the move is given up the old way (resync, "out of sync" notice),
 * well inside the 30 s correlation TTL that would otherwise drop it silently.
 */
const MOVE_RESEND_WAIT_MS = 20_000;

/**
 * How long a peer must stay on the roster before their presence turns the
 * climber's gestures into browsing.
 *
 * Sized against what it is filtering, not against a feel target: the roster
 * blips this exists to absorb are a reconnect landing before the previous
 * connection's `UserLeft`, which resolves in well under a second once the
 * server catches up. Three seconds clears that with room to spare and is still
 * short enough that a climber who genuinely walks up with a friend never
 * notices the gate arriving late.
 */
export const SHARED_SESSION_DWELL_MS = 3_000;

export function QueueProvider({ children }: { children: ReactNode }) {
  const authTransportRevision = useAuthTransportRevision();
  const [state, dispatch] = useReducer(queueReducer, defaultSearchParams, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Playlist appends share one serialized wire lane. The generation is bumped
  // by explicit queue/session/account intent so queued work can be abandoned
  // before it reaches a different room or overwrites a newer queue decision.
  const queueMutationGenerationRef = useRef(0);
  const queueMutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const resyncFlightsByOriginRef = useRef(new Map<string, QueueResyncFlight>());
  // What the server holds differs from this phone's queue in two ways the lane
  // knows about, and every positional send waiting on it is re-read against
  // both before it goes (`serverIndexIn`):
  // - a lane add that failed: the climb is still here, the server never took it
  // - a lane removal not yet sent: the climb is gone here, the server still has it
  const laneFailedAddUuidsRef = useRef(new Set<string>());
  const laneUnsentRemovalUuidsRef = useRef(new Set<string>());
  const authenticatedUserIdRef = useRef<string | null>(null);
  const lastKnownAuthenticatedUserIdRef = useRef<string | null>(null);
  const lastObservedAuthenticationRef = useRef<boolean | null>(null);
  const invalidateQueuedQueueMutations = useCallback(() => {
    queueMutationGenerationRef.current += 1;
    resyncFlightsByOriginRef.current.clear();
    laneFailedAddUuidsRef.current.clear();
    laneUnsentRemovalUuidsRef.current.clear();
  }, []);
  // A real origin switch gets an independent lane. A request already on the
  // old lane may still settle, but its generation fence prevents it from sending
  // more work or reconciling into the new room. In particular, a hung old-room
  // request must not hold the new room's playlist behind its promise tail.
  const resetQueueMutationLane = useCallback(() => {
    queueMutationGenerationRef.current += 1;
    queueMutationTailRef.current = Promise.resolve();
    resyncFlightsByOriginRef.current.clear();
    laneFailedAddUuidsRef.current.clear();
    laneUnsentRemovalUuidsRef.current.clear();
  }, []);
  // The transport owns bounded attempts and rate-limit retries. Keep the lane
  // waiting for that promise; racing it against another deadline would let its
  // abandoned retry remove a climb AFTER a later Undo restored it.
  const enqueueQueueMutation = useCallback((operation: () => Promise<void>): Promise<void> => {
    const nextOperation = queueMutationTailRef.current.then(operation, operation);
    queueMutationTailRef.current = nextOperation.catch(() => undefined);
    return nextOperation;
  }, []);
  const captureQueueMutationOrigin = useCallback(
    (): QueueMutationOrigin => ({
      generation: queueMutationGenerationRef.current,
      sessionId: sessionIdRef.current,
      authenticatedUserId: authenticatedUserIdRef.current,
    }),
    [],
  );
  const isQueueMutationOriginCurrent = useCallback(
    (origin: QueueMutationOrigin) =>
      origin.generation === queueMutationGenerationRef.current &&
      origin.sessionId === sessionIdRef.current &&
      // A queue write started while the authenticated profile was still
      // loading remains valid when that first identity resolves. Once known,
      // account changes always bump the generation above.
      (origin.authenticatedUserId === null || origin.authenticatedUserId === authenticatedUserIdRef.current),
    [],
  );
  // Live session analytics + presence. liveStats is pushed over `sessionUpdates`
  // (SessionStatsUpdated); the roster is seeded from JOIN_SESSION and kept
  // current via UserJoined/UserLeft/UserPresenceChanged.
  const [liveStats, setLiveStats] = useState<SessionLiveStatsEvent | null>(null);
  const [sessionRuntimeState, setSessionRuntimeState] =
    useState<MobileSessionRuntimeState>(createEmptySessionRuntimeState);
  // Latest-committed mirror, read by the realtime engine's snapshot-reconcile
  // telemetry (which can't observe the functional state updater's result).
  const sessionRuntimeStateRef = useRef(sessionRuntimeState);
  sessionRuntimeStateRef.current = sessionRuntimeState;
  // The boardPath of a local angle change whose setSessionBoardPath broadcast is
  // still in flight, else null. While set, the reconnect roster-snapshot's
  // angle-follow is suppressed (see useSessionRealtime) so a snapshot carrying
  // the session's not-yet-updated boardPath can't drag the wall back off the
  // angle we just picked.
  const pendingLocalBoardPathRef = useRef<string | null>(null);
  // Monotonic token so an in-flight setSessionBoardPath only clears the guard
  // when it's still the latest — two overlapping calls carrying the SAME
  // boardPath string can't be told apart by value, so a token is what keeps a
  // rapid same-value toggle from clearing the ref while a later call is live.
  const boardPathBroadcastTokenRef = useRef(0);
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
  // Coalesce resyncs per captured account/room/intent origin. A burst in one
  // origin gets one trailing read, while a newly active account or queue intent
  // can reconcile without waiting for an obsolete request to settle. Flight
  // identity keeps an older finally block from clearing newer cleanup state.
  // Set by the session effect to a hook that tears down + restarts the joined
  // WS subscriptions (its startJoinedSubscriptions closure). Used by
  // resyncQueueFromServer as the fallback when the HTTP snapshot is
  // unavailable — see the membership note there. Null when no session effect
  // is live.
  const restartJoinedSubscriptionsRef = useRef<(() => void) | null>(null);
  // Sequence-gap / stale-event dedup / hash-drift gate for the active session's
  // queueUpdates stream (createQueueSyncGate from @boardsesh/queue-runtime —
  // the same decision logic web is being migrated to). One instance per
  // session: the session effect below creates it, resets it on socket
  // `closed`, and nulls it out when there's no session. The 60s hash watchdog
  // effect (declared later, once resyncQueueFromServerRef exists) reads it
  // through this ref so it always evaluates against the CURRENT session's
  // gate rather than one captured in a stale closure.
  const queueSyncGateRef = useRef<QueueSyncGate | null>(null);
  // True once the queueUpdates stream on the bound connection has delivered its
  // opening FullSync, false from every socket close until the next one. Past
  // that point every change in the session reaches this phone as a live event.
  // useSessionRealtime owns the writes.
  const queueStreamLiveRef = useRef(false);

  // A current-climb change whose broadcast was skipped because the target climb
  // was still unresolved (a thin peer item advanced onto by next/previousClimb —
  // see dispatchSetCurrent, #3868). We can't send a placeholder ClimbInput (uuid
  // may be empty; name/frames are `String!` server-side), so we defer: when
  // useQueueResolveClimbs hydrates that slot WHILE IT'S STILL CURRENT, the effect
  // below fires the real setCurrentClimb so peers, late joiners, and a peer-held
  // wall LED link finally advance. Cleared by any other broadcastable change (a
  // resolved setCurrentClimb, setQueue, clearQueue) and by the effect when
  // current moves off this slot, so a stale hydrate can never re-broadcast an
  // item the session already moved past.
  //
  // The deferral carries the session it was captured in (`sessionId`) so the
  // re-broadcast effect can bail SYNCHRONOUSLY if we've since switched rooms
  // (PR #3894 Codex thread 3). The `[sessionId]` clear below is a passive effect,
  // but joinSession / createSessionWithConfig write `sessionIdRef.current`
  // synchronously before setSessionId — so a hydration-re-broadcast effect still
  // pending from the prior commit can flush (with sessionIdRef already pointing
  // at the new room) before that clear runs, and broadcast the old room's climb
  // into the new one. Comparing `deferred.sessionId` to `sessionIdRef.current` at
  // fire time closes that window; the effect-based clear stays as a backstop.
  const pendingUnsyncedCurrentRef = useRef<{ queueItemUuid: string; sessionId: string | null } | null>(null);

  // The origin and send-time sequence of each recent setCurrentClimb send, by
  // correlation id. A send the coalescer drained fails long after its caller's
  // promise resolved, so this is where its failure handler finds them.
  const moveSendsRef = useRef(new Map<string, MoveSend>());
  // A move whose send missed the session and waits to be re-sent (see
  // handleSetCurrentClimbFailure). The re-send effect fires it once the reducer
  // marks the unconfirmed move `ready`. `queueAdds` are slots that never reached
  // the crew: the move's own (when it added one) and any a superseded lost send
  // added. They go out once the re-send has, or once the move is given up, and
  // not before: a new slot landing first moves the session's sequence on, and
  // the reducer would then read the rejoin snapshot as "something happened".
  const moveResendRef = useRef<{
    correlationId: string;
    /** The climb the move put on the wall. */
    itemUuid: string;
    origin: QueueMutationOrigin;
    /** The last sequence applied when it was parked: did the session move it since? */
    parkedAtSequence: number | undefined;
    queueAdds: ClimbQueueItem[];
  } | null>(null);
  // Gives up a move still waiting for its re-send after MOVE_RESEND_WAIT_MS.
  // Set only while moveResendRef holds that move.
  const moveResendFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The correlation id of the last move re-sent. moveResendRef is empty once
  // the re-send is out, so this is what stops a second send of it.
  const resentMoveCorrelationIdRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (moveResendFallbackTimerRef.current) clearTimeout(moveResendFallbackTimerRef.current);
    },
    [],
  );
  // The mutations factory is built before the failure handler exists, so its
  // drained-failure hook reaches the handler through this ref.
  // Returns whether it took over a lost queue-add, so the coalescer skips its own.
  const handleSetCurrentClimbFailureRef = useRef<(error: unknown, failure: SetCurrentClimbFailure) => boolean>(
    () => false,
  );

  // The active board is the angle source of truth. Read it here so the
  // self-healing re-grade effect can compare each queued climb's display angle
  // to the live angle, and so inbound SessionBoardPathChanged events can write
  // the new angle back. `setActiveBoard` is stable; keep a ref for the WS
  // handler so the subscription effect doesn't re-subscribe on board changes.
  const { data: activeBoard, isPending: isActiveBoardPending } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const setActiveBoardRef = useRef(setActiveBoard);
  setActiveBoardRef.current = setActiveBoard;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Does the server hold this climb, as far as the lane knows? Called from a
  // lane send, once every earlier send on the lane has landed: a climb here is
  // there unless its lane add failed, and a climb gone from here is still there
  // while its lane removal waits. Peers' changes are not seen, as with every
  // send.
  const isOnServer = useCallback((queueItemUuid: string, liveUuids: ReadonlySet<string>) => {
    if (laneFailedAddUuidsRef.current.has(queueItemUuid)) return false;
    return liveUuids.has(queueItemUuid) || laneUnsentRemovalUuidsRef.current.has(queueItemUuid);
  }, []);
  // Where `uuid` sits on the SERVER, read off `order`, an order this phone had
  // when the climber acted: the climbs ahead of it that the server holds now.
  // A climb removed since went straight out, so the server has dropped it too.
  // -1 when `uuid` is not in `order`.
  const serverIndexIn = useCallback(
    (order: readonly ClimbQueueItem[], uuid: string): number => {
      const liveUuids = new Set(stateRef.current.queue.map((queueItem) => queueItem.uuid));
      let index = 0;
      for (const queueItem of order) {
        if (queueItem.uuid === uuid) return index;
        if (isOnServer(queueItem.uuid, liveUuids)) index += 1;
      }
      return -1;
    },
    [isOnServer],
  );
  // Playlist suggestion source lives in provider state, NOT the reducer: the
  // reducer clears its suggestion field on full server syncs (INITIAL_QUEUE_DATA
  // / UPDATE_QUEUE), which would wipe the source the moment activation
  // creates/syncs a session — killing swipe-through-playlist. Web keeps it
  // outside the reducer for the same reason. The ref mirrors it so the
  // imperative nextClimb path reads the latest value.
  const [rawPlaylistSuggestionSource, setPlaylistSuggestionSourceState] = useState<PlaylistSuggestionSource | null>(
    null,
  );
  // The board key a suggestion source must carry to still be usable. Angle is
  // absent by construction (`getQueueBoardKey` excludes it), so tilting the wall
  // keeps the feed alive; a layout, size or set change retires it.
  const activeBoardKey = useMemo(
    () =>
      activeBoard
        ? getQueueBoardKey({
            board_name: activeBoard.boardType,
            layout_id: activeBoard.layoutId,
            size_id: activeBoard.sizeId,
            set_ids: activeBoard.setIds,
          })
        : null,
    [activeBoard],
  );
  // Issue #5099: a source stamped with the board the climber just left kept
  // feeding `next` that board's climbs, which draw nothing here and light
  // nothing on the wall — and, because a committed peek is appended to the
  // queue, left a foreign-board climb behind on every swipe.
  //
  // Derived during render rather than cleared in an effect: `nextClimb` reads
  // `playlistSuggestionSourceRef`, which is assigned during render too, so an
  // effect would leave one committed render where a swipe still walks the old
  // board's list. Keyed on the board VALUE, so it covers every `setActiveBoard`
  // call site rather than the one activation helper, and an unknown active board
  // fails open.
  //
  // Masked rather than cleared, so switching straight back returns the climber
  // to the list they were browsing. One slot, one source — holding a source per
  // board would need state that outlives the snapshot we persist.
  //
  // Masking is the whole of it. A board switch used to REPLACE the masked source
  // with the board's popular-by-ascents feed so a swipe had somewhere to go; that
  // fed climbers climbs they had filtered out and never asked for (issue #5403).
  // A swipe now stops at the end of the climber's own list instead.
  //
  // The mask is also where the source stops steering swipes once the climber
  // moves off its list. Plenty of paths move the current climb without going
  // through `setCurrentClimb` — a crew member's CurrentClimbChanged, a widget
  // Next/Previous tap, joining a session already parked on a climb — and a
  // source that no longer holds the current climb would keep aiming next/prev at
  // a list nobody is on. `anchoredSuggestionSource` is the same predicate the
  // play drawer resolves with, applied here during render so it holds for every
  // writer at once. It used to be an effect, which left one render in which a
  // swipe walked the stale list (issue #5403). The state is left alone: return
  // to a climb on the list and the track is live again.
  const currentClimbItemForSource = state.currentClimbQueueItem;
  const currentClimbForSource = currentClimbItemForSource?.climb;
  const boardSuggestionCompatibilityCache = useMemo(createBoardSuggestionCompatibilityCache, []);
  const anchoredSourceForBoard = useMemo(
    () => anchoredSuggestionSource(rawPlaylistSuggestionSource, currentClimbItemForSource),
    [rawPlaylistSuggestionSource, currentClimbItemForSource],
  );
  // Resolve the target each render: catalogue targets are stable, while spray
  // resets/grant changes produce a new target through the registry's token.
  const suggestionCompatibilityTarget =
    anchoredSourceForBoard && activeBoard && anchoredSourceForBoard.boardKey === activeBoardKey
      ? getPlaylistRenderBoardTarget({
          boardName: activeBoard.boardType,
          layoutId: activeBoard.layoutId,
          sizeId: activeBoard.sizeId,
          setIds: activeBoard.setIds,
          angle: activeBoard.angle,
        })
      : null;
  const suggestionPrivacyEpoch = getPrivacyRevocationGeneration();
  const suggestionCredentialEpoch = getPrivacyCredentialGeneration();
  const playlistSuggestionSource = useMemo(() => {
    const anchored = anchoredSourceForBoard;
    if (!anchored || !activeBoard || activeBoardKey == null) return anchored;
    if (anchored.boardKey !== activeBoardKey) return null;
    if (!suggestionCompatibilityTarget) return anchored;
    const normalized = boardSuggestionCompatibilityCache.normalize(
      anchored,
      suggestionCompatibilityTarget,
      suggestionPrivacyEpoch,
      suggestionCredentialEpoch,
    );
    // Old mixed snapshots can also have a foreign current climb. Preserve its
    // position as an anchor, never as a successor, so the surviving list is reachable.
    if (
      currentClimbForSource &&
      normalized !== anchored &&
      anchored.climbs.some(({ uuid }) => uuid === currentClimbForSource.uuid) &&
      !normalized.climbs.some(({ uuid }) => uuid === currentClimbForSource.uuid)
    ) {
      // Despite the helper's name, the climbs here are `normalized.climbs` —
      // the climber's OWN source masked down to this board, never a popular
      // feed. Nothing outside their list can enter through this call.
      return createBoardFeedSuggestionSource({
        anchorClimb: currentClimbForSource,
        feedClimbs: normalized.climbs,
        boardKey: activeBoardKey,
      });
    }
    return normalized;
  }, [
    anchoredSourceForBoard,
    activeBoard,
    activeBoardKey,
    currentClimbForSource,
    boardSuggestionCompatibilityCache,
    suggestionCompatibilityTarget,
    suggestionPrivacyEpoch,
    suggestionCredentialEpoch,
  ]);
  const playlistSuggestionSourceRef = useRef<PlaylistSuggestionSource | null>(null);
  playlistSuggestionSourceRef.current = playlistSuggestionSource;

  // A held track stopped steering swipes: the climber still has a source, but the
  // mask above resolved it to null, so next/prev fall back to the queue (#5402).
  //
  // Edge-triggered on the SOURCE, not on the state. The mask is a memo, so a
  // state-shaped check would fire once per render for as long as the climber sat
  // on an off-list climb. Keying on the source identity also covers the two ways
  // out of dormancy: the track reviving (the climber swipes back onto the list —
  // #5403 leaves the state in place, so this is no longer one-way) and a fresh
  // selection replacing it. Either way the next dormancy is a new episode.
  //
  // Consequence for anyone querying this: it counts EPISODES, not climbers. One
  // climber wandering off their list four times is four rows.
  const dormantForSourceRef = useRef<PlaylistSuggestionSource | null>(null);
  useEffect(() => {
    if (!rawPlaylistSuggestionSource || playlistSuggestionSource) {
      dormantForSourceRef.current = null;
      return;
    }
    if (dormantForSourceRef.current === rawPlaylistSuggestionSource) return;
    dormantForSourceRef.current = rawPlaylistSuggestionSource;
    // Three ways the mask nulls a held source, kept apart rather than pooled:
    // pooling distinct causes into one bucket is what made BOARDSESH-AK
    // unreadable (#4737). Board first, since an off-board source is masked before
    // the anchor question is even asked.
    const onThisBoard = activeBoardKey != null && rawPlaylistSuggestionSource.boardKey === activeBoardKey;
    const currentUuid = currentClimbForSource?.uuid;
    const leftTrack =
      currentUuid != null && !rawPlaylistSuggestionSource.climbs.some(({ uuid }) => uuid === currentUuid);
    track(SHARED_EVENTS.QueueSwipeTrackDormant, {
      reason: !onThisBoard ? 'board_switched' : leftTrack ? 'current_climb_left_track' : 'nothing_drawable_on_board',
      boardName: activeBoardRef.current?.boardType ?? null,
      trackLength: rawPlaylistSuggestionSource.climbs.length,
      msSinceSelection: suggestionSourceSelectedAtRef.current
        ? Date.now() - suggestionSourceSelectedAtRef.current
        : null,
    });
  }, [rawPlaylistSuggestionSource, playlistSuggestionSource, activeBoardKey, currentClimbForSource]);
  const { showToast } = useToast();
  const { showQueueAddedSnackbar } = useQueueSnackbar();
  const { t } = useTranslation('session');
  // The cross-board strings live beside the BLE spill-skip notice they mirror.
  const { t: tSettings } = useTranslation('settings');

  // The signed-in user's display name + avatar (undefined while signed out or
  // still loading). Sent with JOIN_SESSION so the backend roster shows real
  // identity instead of a `User-<uuid>` fallback + empty avatar. Mirrored into a
  // ref because the joinTracker is memoized once (empty deps) and its execute
  // closure must read the latest value — mirrors web's usernameRef/avatarUrlRef
  // in persistent-session/hooks/session-connection-ports.ts.
  const {
    username: partyUsername,
    avatarUrl: partyAvatarUrl,
    authenticatedUserId,
    isAuthenticated,
  } = usePartyProfile();
  const previousAuthentication = lastObservedAuthenticationRef.current;
  const lastKnownAuthenticatedUserId = lastKnownAuthenticatedUserIdRef.current;
  if (previousAuthentication !== null && previousAuthentication !== isAuthenticated) {
    resetQueueMutationLane();
  }
  if (isAuthenticated && authenticatedUserId) {
    if (lastKnownAuthenticatedUserId && lastKnownAuthenticatedUserId !== authenticatedUserId) {
      resetQueueMutationLane();
    }
    lastKnownAuthenticatedUserIdRef.current = authenticatedUserId;
    authenticatedUserIdRef.current = authenticatedUserId;
  } else if (isAuthenticated) {
    // Profile queries can briefly go empty during a same-account refresh. Keep
    // the last stable identity so ordinary token/profile refreshes don't look
    // like an account switch.
    authenticatedUserIdRef.current = lastKnownAuthenticatedUserIdRef.current;
  } else {
    lastKnownAuthenticatedUserIdRef.current = null;
    authenticatedUserIdRef.current = null;
  }
  lastObservedAuthenticationRef.current = isAuthenticated;
  const subscribeToQueuePrivacy = useCallback(
    (notify: () => void) =>
      subscribeToPrivacyRevocations(() => {
        // Imperative readers and delayed mutation callbacks must lose the copied
        // payload before React's next commit. Keep list order and current selection.
        resetQueueMutationLane();
        invalidateStoredQueueSnapshot();
        const snapshot = sanitizeQueueSnapshot(stateRef.current);
        stateRef.current = snapshot;
        playlistSuggestionSourceRef.current = null;
        boardSuggestionCompatibilityCache.clear();
        pendingUnsyncedCurrentRef.current = null;
        dispatch({ type: 'UPDATE_QUEUE', payload: snapshot });
        setPlaylistSuggestionSourceState(null);
        setLiveStats(null);
        setSessionRuntimeState(createEmptySessionRuntimeState());
        notify();
      }),
    [resetQueueMutationLane, boardSuggestionCompatibilityCache],
  );
  const privacyRevocationGeneration = useSyncExternalStore(
    subscribeToQueuePrivacy,
    getPrivacyRevocationGeneration,
    getPrivacyRevocationGeneration,
  );
  const undoScopeIdentity = JSON.stringify([
    sessionId,
    activeBoardKey,
    isAuthenticated,
    authenticatedUserIdRef.current,
  ]);
  const undoScopeIdentityRef = useRef({ identity: undoScopeIdentity, revision: 0 });
  if (undoScopeIdentityRef.current.identity !== undoScopeIdentity) {
    undoScopeIdentityRef.current = { identity: undoScopeIdentity, revision: undoScopeIdentityRef.current.revision + 1 };
  }
  // A switch away and back still retires an already queued Undo.
  const undoScope = JSON.stringify([
    undoScopeIdentity,
    undoScopeIdentityRef.current.revision,
    privacyRevocationGeneration,
  ]);
  const undoScopeRef = useRef(undoScope);
  undoScopeRef.current = undoScope;
  const identityRef = useRef<{ username: string | undefined; avatarUrl: string | undefined }>({
    username: partyUsername,
    avatarUrl: partyAvatarUrl,
  });
  identityRef.current = { username: partyUsername, avatarUrl: partyAvatarUrl };
  // The identity last announced to the session, seeded at JOIN time so the
  // re-announce effect (below) only fires when it changes afterwards — e.g. the
  // profile resolved after a cold-launch eager join, or the user edited it.
  const announcedIdentityRef = useRef<{ username: string | undefined; avatarUrl: string | undefined } | null>(null);

  // The attribution this device stamps onto a queue item IT introduces, or null
  // while signed out / before the authenticated account profile resolves.
  // Assigned during render
  // (same pattern as identityRef) so the queue callbacks — memoized on
  // `mutations`, not on identity — always read the latest.
  //
  // Backend privacy checks resolve addedByUser.id against users.id. The device
  // party-profile UUID is only local identity and must never author queue rows.
  // Wait for the signed-in account ID and a non-blank display name; do not borrow
  // a remembered account or device ID during hydration or sign-out.
  //
  // Assigned during render, so there is a window between a session join landing
  // a new `clientId` and the next render where a stamp would carry
  // `addedBy: null` with `addedByUser` populated. Peers render the avatar off
  // `addedByUser`, so the row still shows the right person; only the legacy
  // clientId field is absent. Same trade the other during-render refs here make.
  const selfAttributionRef = useRef<QueueItemAttribution | null>(null);
  selfAttributionRef.current =
    isAuthenticated && authenticatedUserId && partyUsername?.trim()
      ? {
          addedBy: sessionRuntimeStateRef.current.clientId || null,
          addedByUser: { id: authenticatedUserId, username: partyUsername, avatarUrl: partyAvatarUrl ?? null },
        }
      : null;

  /**
   * Stamp this device's identity onto an item it is INTRODUCING to the queue.
   *
   * Deliberately not done in `toQueueItemInput`: a wire-level fallback would
   * claim authorship of any unattributed item on the next full-queue write —
   * including a peer's item that arrived before their profile resolved. So skip
   * an item that already carries attribution, and skip anything already sitting
   * in this device's queue (that item is not ours to claim; whatever it carries
   * came from the crew).
   *
   * `existingUuids` lets a whole-queue write hoist that membership lookup once
   * rather than rescanning the current queue per item — playlist activation can
   * hand us the entire board list. Omit it and the scan is used.
   */
  const attributeNewItem = useCallback((item: ClimbQueueItem, existingUuids?: Set<string>): ClimbQueueItem => {
    const self = selfAttributionRef.current;
    if (!self) return item;
    if (item.addedBy || item.addedByUser) return item;
    const alreadyQueued = existingUuids
      ? existingUuids.has(item.uuid)
      : stateRef.current.queue.some((queueItem) => queueItem.uuid === item.uuid);
    if (alreadyQueued) return item;
    return { ...item, ...self };
  }, []);

  // The active board is read synchronously from the React Query cache
  // (staleTime: Infinity, hydrated from AsyncStorage) so analytics call sites
  // can tag events with the current board layout without re-creating the
  // callbacks on every board switch — mirror it into a ref the handlers read.
  const activeBoardRef = useRef(activeBoard);
  activeBoardRef.current = activeBoard;

  // The other walls at this gym. A queued climb on one of them is somewhere the
  // climber can walk to, so it stays a swipe target instead of being skipped
  // past (#5099's skip was written for a board in another city) and it no longer
  // raises the cross-board add prompt — mixing walls at a multi-wall gym is the
  // deliberate act that prompt exists to catch the ACCIDENT of.
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);
  // One stable identity per roster, because this feeds the forward-selection
  // memo that decides the next swipe target.
  const isReachableClimb = useMemo(() => {
    if (reachableBoardKeys.size === 0) return undefined;
    return (climb: Climb) => isClimbOnReachableBoard(climb, reachableBoardKeys);
  }, [reachableBoardKeys]);
  const isReachableClimbRef = useRef(isReachableClimb);
  isReachableClimbRef.current = isReachableClimb;
  const reachableBoardKeysRef = useRef(reachableBoardKeys);
  reachableBoardKeysRef.current = reachableBoardKeys;

  // Board-render A/B telemetry (issue #2202). QueueProvider mounts once near
  // the app root, so this is the one place that registers `render_mode` /
  // `glow_falloff` / `glow_falloff_source` as PostHog super properties —
  // rather than every virtualized board row re-registering the same values.
  //
  // Deliberately NOT `useEffectiveBoardRenderSettings` from
  // use-native-climb-render.ts: that file's other imports (board-details,
  // background-image-cache) eagerly import `expo-asset`, which crashes any
  // test environment that hasn't mocked it — every queue-provider-*.test.tsx
  // suite, none of which had a reason to before. This reads the SAME
  // capability state through ../hooks/boardsesh-renderer-support (a plain,
  // dependency-free module) instead, and — the one behavioural difference —
  // does not itself TRIGGER the capability probe. In practice that never
  // matters: a board is always rendering (list thumbnails, the play view)
  // well before a climb becomes "active" here, and that render is what starts
  // the probe. `renderSettingsPending` below covers the cold-start window
  // where it hasn't answered yet.
  const { settings: boardRenderSettings, loaded: boardRenderSettingsLoaded } = useBoardRenderSettings();
  const boardseshSupportTick = useSyncExternalStore(
    subscribeToBoardseshSupport,
    getBoardseshSupportRevision,
    getBoardseshSupportRevision,
  );
  const { effectiveRenderSettings, renderSettingsPending } = useMemo(() => {
    void boardseshSupportTick;
    const rendererSupport = getBoardseshRendererSupport();
    return {
      effectiveRenderSettings: resolveEffectiveRenderSettings(boardRenderSettings, rendererSupport === true),
      // "We cannot yet say which drawing this climber is looking at." Two
      // sources, both cold-start-only and both self-clearing:
      //  - the climber's own stored settings haven't come back from
      //    AsyncStorage, so a stored `boardsesh` still reads as `default`;
      //  - the mode being asked for IS `boardsesh` but the capability probe
      //    has not answered (`null`), which resolves to `classic` for safety.
      // Reported on `Board Render Failed` and the board-look step events, so a
      // render whose mode is still unresolved would be filed under the wrong
      // drawing — the screenshot log below waits this out for the same reason.
      renderSettingsPending:
        !boardRenderSettingsLoaded ||
        (rendererSupport === null && requestedBoardRenderMode(boardRenderSettings) === 'aura'),
    };
  }, [boardRenderSettings, boardRenderSettingsLoaded, boardseshSupportTick]);
  // Screenshot builds: state which drawing the capture is actually going to get.
  // The probe can veto Aura on a binary too old to draw it, and the fallback is
  // silent — without this line a whole store set comes back in the classic look
  // and nobody notices until the listing is live.
  // `findScreenshotRenderProblems` (scripts/mobile-screenshots.ts) reads this out
  // of the captured log and fails the run. Dead-strips in normal builds.
  //
  // Deduped on the message rather than latched to the first one: if anything ever
  // moved the resolved mode after the first settled frame, latching would leave
  // the log describing a drawing the capture didn't use, and the gate reads every
  // one of these lines — so a late change has to be able to produce a second.
  const lastLoggedRenderMode = useRef<string | null>(null);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
    if (renderSettingsPending) return;
    const probe = getBoardseshRendererSupport();
    const message =
      `[screenshot] render mode: ${effectiveRenderSettings.mode} ` +
      `(requested ${requestedBoardRenderMode(boardRenderSettings)}, ` +
      `probe ${probe === null ? 'unanswered' : probe ? 'ok' : 'unavailable'})`;
    if (message === lastLoggedRenderMode.current) return;
    lastLoggedRenderMode.current = message;
    console.log(message);
  }, [effectiveRenderSettings, renderSettingsPending, boardRenderSettings]);

  // Registered as PostHog super properties so every board-render event —
  // `Board Render Failed`, the board-look step pair — reads the same resolved
  // drawing the per-event props carry.
  useEffect(() => {
    registerRenderSuperProperties(effectiveRenderSettings);
  }, [effectiveRenderSettings]);

  // "This climb is on another board — add anyway / switch / cancel". Stable
  // identity, so `addToQueue` (and the memoized actions context) never churns.
  const requestCrossBoardAdd = useCrossBoardAddGate();

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
          return buildSessionBoardPath(activeBoard);
        },
        execute: async ({ sessionId: sid, boardPath }) => {
          const privacyGeneration = getPrivacyRevocationGeneration();
          // Snapshot identity at the moment we build the payload. If the profile
          // resolves while JOIN is in flight, we must record the values we
          // actually sent — not identityRef.current's newer ones — so the
          // re-announce effect still fires UPDATE_USERNAME for the new identity.
          const sentIdentity = { username: identityRef.current.username, avatarUrl: identityRef.current.avatarUrl };
          const result = await execute<{
            joinSession?: {
              participantId?: string | null;
              clientId?: string | null;
              isLeader?: boolean | null;
              lastConnectedBoardSerial?: string | null;
              boardPath?: string | null;
              users?: SessionUser[] | null;
            };
          }>(getWsClient, {
            query: JOIN_SESSION,
            variables: {
              sessionId: sid,
              boardPath,
              username: sentIdentity.username,
              avatarUrl: sentIdentity.avatarUrl,
            },
          });
          if (privacyGeneration !== getPrivacyRevocationGeneration()) throw new Error('Queue authorization changed');
          // Remember what we announced so the re-announce effect only fires if
          // the identity changes after this join (profile loaded late / edited).
          announcedIdentityRef.current = sentIdentity;
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
            // Stable participant id — the roster is keyed by this (a user UUID for
            // signed-in members, the connection id for anonymous ones). Roster
            // self-matching in applySessionRuntimeEvent compares against this, NOT
            // clientId, so the snapshot handler works in authenticated sessions.
            participantId: joined?.participantId ?? joined?.clientId ?? '',
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
  // A join belongs to the connection it ran on. The realtime engine bumps the
  // epoch on closes of the client it is bound to, but a mutation's
  // `ensureJoined` can run while the engine is parked and bound to nothing.
  // Every end of the shared connection retires the cached join.
  useEffect(() => subscribeWsConnectionEnded(() => joinTracker.bumpEpoch()), [joinTracker]);

  // Re-announce identity to the session when it changes after we've joined.
  // JOIN_SESSION already carries the profile in the common case; this covers the
  // race where the authenticated profile resolves after a cold-launch eager join
  // (roster would otherwise stay on the `User-<uuid>` fallback), and profile
  // edits made mid-session. `announcedIdentityRef` is seeded at join time so this
  // never fires a redundant re-announce right after joining. Best-effort, but the
  // ref only advances on success — so a transient failure is retried the next
  // time identity changes instead of being silently swallowed.
  useEffect(() => {
    if (!participantId || !partyUsername) return;
    const announced = announcedIdentityRef.current;
    if (announced && announced.username === partyUsername && announced.avatarUrl === partyAvatarUrl) return;
    const pending = { username: partyUsername, avatarUrl: partyAvatarUrl };
    void execute(getWsClient, { query: UPDATE_USERNAME, variables: pending })
      .then(() => {
        announcedIdentityRef.current = pending;
      })
      .catch((error) => {
        if (__DEV__) console.warn('[queue] failed to re-announce identity', error);
      });
  }, [participantId, partyUsername, partyAvatarUrl]);

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
    if (sessionIdRef.current !== sessionId) resetQueueMutationLane();
    sessionIdRef.current = sessionId;
    // Backstop clear on any session change — start, join, leave, or a direct A→B
    // switch (#3868). The primary guard is the re-broadcast effect's synchronous
    // deferred.sessionId vs sessionIdRef.current check (PR #3894 Codex thread 3);
    // this passive-effect clear can't fire before an already-pending re-broadcast
    // effect flushes, so it's defence-in-depth, not the race fix.
    pendingUnsyncedCurrentRef.current = null;
  }, [resetQueueMutationLane, sessionId]);

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
  // Set by createSessionWithConfig when a new session's local-queue seed throws;
  // read by useSessionRealtime to stop the empty-room FullSync from wiping the
  // live queue and to trigger a re-seed instead (#3878).
  const seedFailedSessionIdRef = useRef<string | null>(null);

  // Transient playback-event listeners. PlaybackStateChanged (route playback
  // party-sync) doesn't mutate queue state, so the play-drawer orchestrator
  // subscribes here and the reducer path skips it. Listeners live in a ref so
  // adding/removing one never tears down the WS subscription effect below.
  const playbackEventListenersRef = useRef<Set<(event: PlaybackStateChangedEvent) => void>>(new Set());
  const subscribeToPlaybackEvents = useCallback((listener: (event: PlaybackStateChangedEvent) => void) => {
    playbackEventListenersRef.current.add(listener);
    return () => {
      playbackEventListenersRef.current.delete(listener);
    };
  }, []);

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
    // sync to peers — and carry the item-level fields (addedBy / addedByUser /
    // tickedBy / suggested) that used to be dropped here, which anonymised every
    // climb queued from a phone and stripped the crew's avatars on the next
    // full-queue write (#3995). See toQueueItemWireInput.
    toQueueItemInput: toQueueItemWireInput,
    // Where a deferred queue-add (a superseded or drained-then-throttled
    // activation) should land, so peers see the order this device shows. Read
    // live off `stateRef` — assigned during render — because the send can fire
    // seconds after the activation. Same read `recoverThrottledQueueAdd` uses.
    getQueuePosition: (uuid) => stateRef.current.queue.findIndex((queueItem) => queueItem.uuid === uuid),
    ensureReady: async (capturedSessionId) => {
      if (!capturedSessionId) return null;
      await ensureJoined(capturedSessionId);
      return capturedSessionId;
    },
    // The last server sequence this device has APPLIED, so a wholesale replace
    // (playlist activation, party seed, empty-room re-seed, offline
    // reconciliation) tells the server which window to merge peer adds back
    // from instead of overwriting them (#3933). Read through the gate ref, not
    // a locally invented counter: a climb this device saw and then dropped sits
    // at or below the baseline and so is never resurrected. Null before the
    // first applied event — the server then keeps its legacy overwrite.
    getBaselineSequence: () => queueSyncGateRef.current?.getLastSequence() ?? null,
    // Best-effort sync failures (coalescer drains for setCurrent / superseded
    // queue-adds) must not alarm: the local reducer already applied the change
    // and the WS subscription reconciles. Dev-log only — a user-facing "Action
    // failed" on a swipe-to-queue or a rapid current-climb change is noise.
    //
    // `setSessionBoardPath` is the exception. Nothing reconciles it: a dropped
    // board-path broadcast leaves this climber on one wall and the rest of the
    // party on another, indefinitely and invisibly. Report it (still no toast —
    // the local move already succeeded and there is nothing to retry by hand).
    // It only fires on an angle change or a board switch, so the Sentry volume
    // stays tiny next to the per-swipe actions above.
    onBestEffortError: (action, error) => {
      if (__DEV__) console.warn(`[queue] best-effort ${action} failed`, error);
      if (action === 'setSessionBoardPath') {
        reportHandledError(error, { tags: { source: 'queue-sync', op: 'set-board-path' } });
      }
    },
    // A move that superseded an earlier one and then failed from the drain
    // loop. Its caller never hears of it, so this is the only way to learn the
    // climber's latest move missed the session (a reconnect, #6783 QA).
    onSetCurrentClimbDrainError: (error, { item, shouldAddToQueue, correlationId }) => {
      if (!item || !correlationId) return false;
      const send = moveSendsRef.current.get(correlationId);
      if (!send) return false;
      return handleSetCurrentClimbFailureRef.current(error, {
        item,
        shouldAddToQueue: shouldAddToQueue === true,
        correlationId,
        ...send,
        drained: true,
      });
    },
  });

  // Stable handle to the whole-queue seed for useSessionRealtime's re-seed after
  // a guarded empty FullSync (#3878). A ref (not an effect dep) so a new
  // `mutations` identity never tears down and rebuilds the subscription effect.
  const reSeedQueueRef = useRef(mutations.setQueue);
  reSeedQueueRef.current = mutations.setQueue;

  // Broadcast the session's boardPath (angle/board) to party members. The
  // shared mutation already swallows transport errors and is a true no-op in
  // solo (never lazily creates a session), so callers can fire it freely.
  //
  // Record the requested boardPath as pending while the broadcast is in flight
  // so the reconnect roster-snapshot's angle-follow doesn't revert us: until the
  // mutation lands, the backend still holds the OLD boardPath, so a snapshot
  // seeded in that window carries it — and our own SessionBoardPathChanged echo
  // is self-suppressed (changedByParticipantId === us), which would otherwise
  // leave us stuck on the old angle. Clear on settle (success OR failure — on
  // failure the server's value is authoritative again), but only if a newer
  // local change hasn't already superseded this one.
  const setSessionBoardPath = useCallback(
    async (boardPath: string) => {
      const token = ++boardPathBroadcastTokenRef.current;
      pendingLocalBoardPathRef.current = boardPath;
      try {
        return await mutations.setSessionBoardPath(boardPath);
      } finally {
        // Clear only if a newer broadcast hasn't superseded us (token match) —
        // robust against two overlapping calls with the same boardPath.
        if (boardPathBroadcastTokenRef.current === token) pendingLocalBoardPathRef.current = null;
      }
    },
    [mutations],
  );
  // Solo-queue persistence: cold-start restore (explicit session first, then the
  // local snapshot) + the debounced solo snapshot save. See useQueuePersistence.
  useQueuePersistence({
    authenticatedUserId,
    identityReady: !isAuthenticated || !!authenticatedUserId,
    privacyRevocationGeneration,
    dispatch,
    sessionIdRef,
    setSessionId,
    stateRef,
    sessionId,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    playlistSuggestionSource,
    setPlaylistSuggestionSourceState,
    activeBoardSettled: !isActiveBoardPending,
  });

  // Explicit session lifecycle commands: create (Start button), join, end, clear.
  // See useSessionCommands. clearSessionRef is read by the session-realtime
  // SessionEnded handler, so keep it pointed at the latest clearSession.
  const { createSessionWithConfig, joinSession, endSession, clearSession } = useSessionCommands({
    showToast,
    t,
    stateRef,
    ensureJoined,
    setQueueMutation: mutations.setQueue,
    seedFailedSessionIdRef,
    setSessionId,
    sessionIdRef,
    onSessionContextChanging: resetQueueMutationLane,
    dispatch,
    setPlaylistSuggestionSourceState,
    setActiveBoard,
    locallyEndingSessionIdRef,
    suppressedRemoteEndSessionIdRef,
  });
  clearSessionRef.current = clearSession;

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
  const resyncQueueFromServer = useCallback(
    async (requestedOrigin: QueueMutationOrigin = captureQueueMutationOrigin()): Promise<boolean> => {
      const origin = requestedOrigin;
      const activeSessionId = origin.sessionId;
      if (!activeSessionId || !isQueueMutationOriginCurrent(origin)) return false;
      const originKey = queueMutationOriginKey(origin);
      const existingFlight = resyncFlightsByOriginRef.current.get(originKey);
      if (existingFlight) {
        // This snapshot may predate another failure in the same origin. Coalesce
        // it into one trailing read after this request settles.
        existingFlight.pending = true;
        return false;
      }
      const flight: QueueResyncFlight = { pending: false };
      resyncFlightsByOriginRef.current.set(originKey, flight);
      const ownsFlight = () => resyncFlightsByOriginRef.current.get(originKey) === flight;
      const mayApplyResult = () => ownsFlight() && isQueueMutationOriginCurrent(origin);

      // Fallback when the HTTP snapshot is unavailable: restart the joined WS
      // subscriptions instead. The HTTP `session` query returns
      // `queueState: null` for callers that fail the session-membership check,
      // and anonymous HTTP callers ALWAYS fail it (membership lives on the WS
      // connection, which HTTP requests don't carry) — so for anonymous
      // participants this fetch can never succeed and gap/drift recovery would
      // silently stop converging. The WS connection IS a member, and a
      // resubscribe's guaranteed initial FullSync heals state and re-baselines
      // the gate through the normal subscription path. At most one restart per
      // resync request, and it can't loop: the restart itself never requests a
      // resync, and clearing the pending flag stops the trailing rerun from
      // chaining into another doomed fetch (the FullSync supersedes whatever
      // that rerun could return anyway).
      const fallbackToSubscriptionRestart = () => {
        if (!mayApplyResult()) return;
        flight.pending = false;
        restartJoinedSubscriptionsRef.current?.();
      };

      try {
        const response = await getHttpClient().request<GetSessionQueueStateQueryResponse>(GET_SESSION_QUEUE_STATE, {
          sessionId: activeSessionId,
        });
        // Account, room or queue intent can change while the HTTP request waits.
        // Check the captured origin before any state, sync-gate or fallback effect.
        if (!mayApplyResult()) return false;
        const queueState = response.session?.queueState;
        if (!queueState) {
          fallbackToSubscriptionRestart();
          return false;
        }
        // A slow snapshot can resolve AFTER a rejoin FullSync already
        // re-baselined the gate to newer state — applying it would regress
        // both the queue and the gate baseline backwards. Same server, so a
        // higher sequence is strictly fresher: skip the apply/re-baseline and
        // report success (the newer FullSync already did the refreshing). A
        // pending trailing rerun still runs — it fetches a fresh snapshot that
        // passes this guard, covering a resync requested after that FullSync.
        const lastTrackedSequence = queueSyncGateRef.current?.getLastSequence() ?? -1;
        if (queueState.sequence < lastTrackedSequence) {
          if (__DEV__) {
            console.info(
              '[queue] skipping stale resync snapshot',
              `snapshot=${queueState.sequence} tracked=${lastTrackedSequence}`,
            );
          }
          return true;
        }
        // The authoritative snapshot resets the current climb — drop any deferred
        // re-broadcast (#3868) so a late hydrate can't re-assert a climb the server
        // no longer has as current.
        if (!mayApplyResult()) return false;
        pendingUnsyncedCurrentRef.current = null;
        // The server's own queue replaces ours, so a failed add it is missing
        // is missing here too, and one it did take is no longer a gap.
        laneFailedAddUuidsRef.current.clear();
        dispatch({
          type: 'INITIAL_QUEUE_DATA',
          serverSequence: queueState.sequence,
          payload: {
            queue: queueState.queue.map(toClimbQueueItem),
            currentClimbQueueItem: queueState.currentClimbQueueItem
              ? toClimbQueueItem(queueState.currentClimbQueueItem)
              : null,
            // A server snapshot of this room: the reducer keeps a move of ours
            // the snapshot predates instead of putting the wall back.
            sessionId: activeSessionId,
          },
        });
        // Re-baseline the sync gate to this snapshot's authoritative
        // sequence/hash — an HTTP resync applies state exactly like a
        // reconnect FullSync (it replaces state with the server's current
        // snapshot), so feed the gate a synthetic FullSync rather than
        // `gate.reset()`. reset() would zero `lastSequence` back to null, and
        // per evaluateIncoming a null lastSequence unconditionally applies the
        // NEXT delta regardless of its sequence — so a stale/superseded event
        // still in flight from before this resync could slip past the
        // dedup/gap check and corrupt the just-fetched state. Feeding the real
        // sequence/hash keeps that protection intact immediately.
        queueSyncGateRef.current?.evaluateIncoming({
          __typename: 'FullSync',
          sequence: queueState.sequence,
          stateHash: queueState.stateHash,
          stateHashOrdered: queueState.stateHashOrdered ?? null,
        });
        return true;
      } catch (error) {
        if (!mayApplyResult()) return false;
        if (__DEV__) console.warn('[queue] resyncQueueFromServer failed', error);
        reportHandledError(error, { tags: { source: 'queue-sync', op: 'resync' } });
        // Same membership rationale as the null-queueState branch — an errored
        // query can't reconcile anything, but a resubscribe's FullSync can.
        fallbackToSubscriptionRestart();
        return false;
      } finally {
        // Only the flight that still owns this origin may clear it or launch its
        // coalesced retry. An older origin must not tear down a newer request.
        if (ownsFlight()) {
          const shouldRerun = flight.pending && isQueueMutationOriginCurrent(origin);
          resyncFlightsByOriginRef.current.delete(originKey);
          if (shouldRerun) void resyncQueueFromServerRef.current(origin);
        }
      }
    },
    [captureQueueMutationOrigin, isQueueMutationOriginCurrent],
  );
  const resyncQueueFromServerRef = useRef(resyncQueueFromServer);
  resyncQueueFromServerRef.current = resyncQueueFromServer;

  // Active-session realtime engine: join retry/backoff, queue + session
  // subscriptions, sync-gate wiring, roster/liveStats/wall-lit updates, peer
  // angle-follow, and the 60s hash watchdog. See useSessionRealtime.
  useSessionRealtime({
    authTransportRevision,
    privacyRevocationGeneration,
    sessionId,
    dispatch,
    coordinator,
    ensureJoined,
    joinTracker,
    sessionIdRef,
    participantIdRef,
    stateRef,
    seedFailedSessionIdRef,
    reSeedQueueRef,
    activeBoardRef,
    setActiveBoardRef,
    showToastRef,
    tRef,
    clearSessionRef,
    playbackEventListenersRef,
    unsubscribeRef,
    queueSyncGateRef,
    queueStreamLiveRef,
    restartJoinedSubscriptionsRef,
    resyncQueueFromServerRef,
    setLiveStats,
    setSessionRuntimeState,
    sessionRuntimeStateRef,
    pendingLocalBoardPathRef,
    setIsSessionWallLit,
    setParticipantId,
    locallyEndingSessionIdRef,
    suppressedRemoteEndSessionIdRef,
  });

  // After a queue mutation fails in a party session, reconcile against the
  // server and tell the user their queue was refreshed. In solo (no session)
  // the local queue is authoritative, so keep the existing best-effort
  // behaviour: dev-log only, no resync, no toast.
  //
  // Callers here (add/remove/setQueue/clearQueue) reconcile on ANY error,
  // rate limits included. They change queue *content* and have no local
  // rollback, so skipping reconciliation would leave the item in your queue
  // and absent from your crew's — permanently and silently. `setCurrentClimb`
  // deliberately does NOT resync when throttled: it moves a pointer that
  // self-heals on the next activation or peer broadcast, so reconciling there
  // only yanked the climber off the boulder they just picked. When that
  // throttled call also carried a queue-add it recovers the content half
  // through recoverThrottledQueueAdd below — and falls back here if even that
  // re-send fails. `reorderQueue` rolls back locally instead, and lands here
  // only when the queue changed while its move waited on the lane.
  const resyncQueueAfterMutationFailure = useCallback(
    async (origin: QueueMutationOrigin) => {
      if (!origin.sessionId || !isQueueMutationOriginCurrent(origin)) return;
      const refreshed = await resyncQueueFromServerRef.current(origin);
      if (refreshed && isQueueMutationOriginCurrent(origin)) {
        showToast(t('mobile.queue.outOfSyncRefreshed'), 'error');
      }
    },
    [isQueueMutationOriginCurrent, showToast, t],
  );

  // Failure handler for the four queue-CONTENT mutations (add/remove/clear/setQueue).
  // A throttled one shows TWO toasts by design (#3929): the pacing hint now, and
  // `outOfSyncRefreshed` a round-trip later once reconciliation replaced the queue —
  // same contract as setCurrentClimb ("Two toasts, deliberately" in the tests).
  // Not showQueueMutationErrorToast: that also fires `actionFailed` on every
  // non-throttle error, and these syncs must stay silent when offline (#2763).
  const reconcileFailedContentMutation = useCallback(
    (error: unknown, origin: QueueMutationOrigin) => {
      if (!isQueueMutationOriginCurrent(origin)) return;
      if (origin.sessionId && isRateLimitedError(error)) showToast(t('mobile.queue.rateLimited'), 'error');
      void resyncQueueAfterMutationFailure(origin);
    },
    [isQueueMutationOriginCurrent, resyncQueueAfterMutationFailure, showToast, t],
  );

  const confirmClimbOnWall = useCallback((climbUuid: string) => mutations.confirmClimbOnWall(climbUuid), [mutations]);
  const setSessionBoardSerial = useCallback((serial: string) => mutations.setSessionBoardSerial(serial), [mutations]);
  // Broadcast that THIS phone's BLE link to the wall dropped. The shared mutation
  // swallows transport errors and is a true no-op in solo (never creates a
  // session), so the BLE provider can fire it on every drop. Locally, our own
  // WallDisconnected echo flips the lightbulb off through the subscription
  // handler — no need to set isSessionWallLit here.
  const reportWallDisconnect = useCallback(() => mutations.reportWallDisconnect(), [mutations]);

  const climbReads = useQueueClimbReads({ activeBoard, privacyRevocationGeneration });

  // Self-healing re-grade: refetch angle-specific grades for queued climbs and
  // the displayed playlist peek whenever the active angle drifts. See useQueueRegrade.
  useQueueRegrade({
    privacyRevocationGeneration,
    activeBoard,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    playlistSuggestionSourceRef,
    playlistSuggestionSource,
    rawPlaylistSuggestionSource,
    dispatch,
    setPlaylistSuggestionSourceState,
    climbReads,
  });

  // Self-healing resolve: a partially-synced peer item (or a snapshot restored
  // before its climb data loaded) can land in the queue with an unresolved climb.
  // Re-fetch it by uuid at the live angle and patch it in place so the row shows
  // the real name/grade/thumbnail instead of an "Unknown Climb" placeholder. See
  // useQueueResolveClimbs (#2527).
  useQueueResolveClimbs({
    activeBoard,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    privacyRevocationGeneration,
    dispatch,
    climbReads,
  });

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

  // The committed half of an add. Everything here re-reads live state, so it is
  // safe to run after an await on the cross-board prompt.
  const commitQueueAdd = useCallback(
    (rawItem: ClimbQueueItem, placement: QueueAddPlacement = 'end') => {
      const origin = captureQueueMutationOrigin();
      // Whoever tapped "add" owns this climb — stamp identity before the dispatch
      // so the local queue and the broadcast carry the same object (#3995).
      const item = attributeNewItem(rawItem);
      // Derive the landing slot ONCE, here, from live state — this runs after the
      // cross-board prompt's await, so a queue that moved while the dialog was up
      // can't leave the position stale. The same number then goes to the local
      // dispatch AND the broadcast, so this client and its peers can't disagree
      // about where the climb landed. `undefined` means append.
      const queueBeforeAdd = stateRef.current.queue;
      const position =
        placement === 'next'
          ? playNextInsertPosition(queueBeforeAdd, stateRef.current.currentClimbQueueItem)
          : undefined;
      // Optimistic local dispatch is the source of truth for the user's queue.
      // The server echoes this item via the WS subscription, but
      // DELTA_ADD_QUEUE_ITEM dedupes by uuid so the echo is a no-op. The shared
      // mutation only SYNCs the add to an existing session (solo is local-only —
      // it never creates one). That sync is best-effort: a solo user with no
      // session, an offline phone, or a transient WS error must NOT see "Action
      // failed" when the local queue is already correct. Dev-log only.
      dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item, position } });
      // partyMode matches web's self-track (QueueContext.tsx): the crew roster
      // holds more than one distinct human. Without it the suppressed self-echo
      // would take `partyMode: true` with it and a PostHog breakdown on
      // partyMode would lose every mobile self-add (#4042).
      track(SHARED_EVENTS.ClimbAddedToQueue, {
        climbUuid: item.climb.uuid,
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        addedFromTab: 'mobile',
        currentQueueLength: stateRef.current.queue.length + 1,
        partyMode: countDistinctSessionUsers(sessionRuntimeStateRef.current?.users) > 1,
        placement,
      });
      // No unresolved-climb guard here: addToQueue is only ever called with a
      // fully-resolved climb from search / detail / playlist (a real user tap),
      // never a peer placeholder. The re-broadcast vectors that need guarding are
      // setCurrentClimb (next/previousClimb can land on an unhydrated peer item)
      // and setQueue (whole-queue replace) — see #2527.
      const reconcileFailedAdd = (error: unknown) => {
        if (!isQueueMutationOriginCurrent(origin)) return;
        if (__DEV__) console.warn('[queue] addQueueItem sync failed', error);
        // In a party session the add never reached peers — reconcile against the
        // server so this client doesn't silently diverge. Solo is a true no-op.
        reconcileFailedContentMutation(error, origin);
      };
      if (position === undefined) {
        // An append commutes with every other queued write, so it goes now.
        mutations.addQueueItem(item, position).catch(reconcileFailedAdd);
      } else {
        // A positional add does not: its index counts climbs this phone has
        // queued but may not have sent yet. A Play next swiped while a
        // whole-list Play next is still draining would otherwise land among the
        // list's climbs on the server, and the hash watchdog would then copy
        // that order back here. Waiting on the serial lane sends it after them.
        // Its slot is re-read at send time too: a climb ahead of it that the
        // climber removed while it waited is already gone from the server.
        const queueWithAdd = [...queueBeforeAdd.slice(0, position), item, ...queueBeforeAdd.slice(position)];
        void enqueueQueueMutation(async () => {
          if (!isQueueMutationOriginCurrent(origin)) return;
          // Removed while it waited: sending now would bring it back for the crew.
          if (mutations.wasUuidExplicitlyRemoved(item.uuid)) return;
          try {
            await mutations.addQueueItem(item, serverIndexIn(queueWithAdd, item.uuid));
            laneFailedAddUuidsRef.current.delete(item.uuid);
          } catch (error) {
            if (isQueueMutationOriginCurrent(origin)) laneFailedAddUuidsRef.current.add(item.uuid);
            reconcileFailedAdd(error);
          }
        });
      }
      // Surface the "Climb added to queue · Open" snackbar for every add path.
      showQueueAddedSnackbar({ kind: placement === 'next' ? 'playNext' : 'added' });
    },
    [
      attributeNewItem,
      captureQueueMutationOrigin,
      enqueueQueueMutation,
      isQueueMutationOriginCurrent,
      mutations,
      reconcileFailedContentMutation,
      serverIndexIn,
      showQueueAddedSnackbar,
    ],
  );

  /**
   * Add a climb to the queue, asking first when it belongs to a board the queue
   * isn't on (see `decideAdd` in @boardsesh/queue). This is the ONE seam every
   * add path goes through — search rows, the climb-action sheet, the play drawer,
   * the board sheet — so a new call site can't skip the gate.
   *
   * Resolves `'cancelled'` only when the climber backed out of that prompt; the
   * same-board path never awaits anything, so a normal add costs nothing extra.
   */
  const addToQueue = useCallback(
    async (rawItem: ClimbQueueItem, options?: { placement?: QueueAddPlacement }): Promise<'added' | 'cancelled'> => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return 'cancelled';
      const activeBoard = activeBoardRef.current;
      const activeConfig = toActiveBoardCompatibilityConfig(activeBoard);
      // `stateRef.current` is reassigned during render, so between a dispatch
      // and its commit this reads the pre-add queue — a second add from the
      // same foreign board inside that sub-frame window would prompt twice.
      // Left as is on purpose: the burst case that can actually fire that fast
      // (several taps before anyone answers) is already collapsed to one prompt
      // by the gate's in-flight dedup, the remaining window needs a second tap
      // within a frame of answering the dialog, and the cost if it ever lands
      // is one extra dialog. Shadowing the accepted set in a ref would trade
      // that for a hand-maintained mirror of reducer state that can drift.
      const decision = decideAdd({
        climb: rawItem.climb,
        activeConfig,
        acceptedConfigKeys: deriveAcceptedConfigs(stateRef.current.queue, activeConfig),
        reachableConfigKeys: reachableBoardKeysRef.current,
        classify: classifyClimbBoardCompatibility,
      });

      if (decision.kind === 'confirm') {
        const result = await requestCrossBoardAdd({
          climbConfigKey: decision.climbConfigKey,
          climbBoardName: decision.climbBoardName,
          climbLayoutId: decision.climbLayoutId,
          activeBoardName: activeBoard?.boardType,
        });
        if (privacyRevocationGeneration !== getPrivacyRevocationGeneration() || result.outcome === 'cancel')
          return 'cancelled';
        if (result.outcome === 'switch') {
          // The queue followed them onto the new board, so peers must too — a
          // local-only switch would leave the session's board path (and every
          // peer's wall) pointing at the board we just left.
          // The shared mutation swallows its own transport errors into
          // `onBestEffortError` (which reports them), so what lands here is the
          // rarer pre-send failure — ensureJoined rejecting. Report that too
          // rather than dropping it, or a party that silently never followed
          // the switch leaves no trace at all.
          // Gym and ledless walls keep their identity when the queue switches.
          void setSessionBoardPath(buildSessionBoardPath(result.board)).catch((error) => {
            if (__DEV__) console.warn('[queue] setSessionBoardPath after board switch failed', error);
            reportHandledError(error, { tags: { source: 'queue-sync', op: 'set-board-path-switch' } });
          });
        }
      }

      commitQueueAdd(rawItem, options?.placement ?? 'end');
      return 'added';
    },
    [commitQueueAdd, requestCrossBoardAdd, setSessionBoardPath, privacyRevocationGeneration],
  );

  const removeFromQueue = useCallback(
    (uuid: string) => {
      const origin = captureQueueMutationOrigin();
      const removedItem = stateRef.current.queue.find((queueItem) => queueItem.uuid === uuid);
      // Same best-effort model as addToQueue: the reducer already removed the
      // item locally; the server mutation only syncs it to an existing session
      // (and no-ops when there's none).
      dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid } });
      // partyMode matches web's self-track (QueueContext.tsx): the crew roster
      // holds more than one distinct human. Without it the suppressed self-echo
      // would take `partyMode: true` with it and a PostHog breakdown on
      // partyMode would lose every mobile self-remove.
      track(SHARED_EVENTS.ClimbRemovedFromQueue, {
        climbUuid: removedItem?.climb.uuid ?? null,
        queueItemUuid: uuid,
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        partyMode: countDistinctSessionUsers(sessionRuntimeStateRef.current?.users) > 1,
        removedBy: 'self',
      });
      mutations.removeQueueItem(uuid).catch((error) => {
        if (!isQueueMutationOriginCurrent(origin)) return;
        if (__DEV__) console.warn('[queue] removeQueueItem sync failed', error);
        // The remove never reached peers in a party session — reconcile so the
        // dropped item doesn't linger on peers (or come back here). Solo no-ops.
        reconcileFailedContentMutation(error, origin);
      });
    },
    [captureQueueMutationOrigin, isQueueMutationOriginCurrent, mutations, reconcileFailedContentMutation],
  );

  const reorderQueue = useCallback(
    (uuid: string, oldIndex: number, newIndex: number, options?: { source?: QueueReorderSource }) => {
      const origin = captureQueueMutationOrigin();
      const previousQueue = stateRef.current.queue;
      // The reducer re-validates uuid-at-oldIndex and ignores a move that fails
      // it. Nothing moved here then, so nothing goes to the crew either.
      if (
        oldIndex < 0 ||
        newIndex < 0 ||
        oldIndex >= previousQueue.length ||
        newIndex >= previousQueue.length ||
        previousQueue[oldIndex].uuid !== uuid
      ) {
        return;
      }
      const reorderedQueue = [...previousQueue];
      const [movedItem] = reorderedQueue.splice(oldIndex, 1);
      reorderedQueue.splice(newIndex, 0, movedItem);
      // Optimistic local reorder; the server's QueueReordered echo is a safe
      // no-op thanks to the same uuid-at-oldIndex check.
      dispatch({ type: 'DELTA_REORDER_QUEUE_ITEM', payload: { uuid, oldIndex, newIndex } });
      track(SHARED_EVENTS.QueueReordered, {
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        oldIndex,
        newIndex,
        partyMode: sessionIdRef.current !== null,
        reorderedBy: 'self',
        source: options?.source ?? 'drag',
      });
      // The wire move carries indexes, and the server splices by index without
      // checking the uuid, so the indexes must describe the server's queue, not
      // this phone's. They differ while the lane drains: a whole-list Play next
      // puts every climb here at once but on the server one send at a time. So
      // the move waits its turn on the lane and reads both indexes at send time
      // (`serverIndexIn`), when every earlier send from this phone has landed.
      void enqueueQueueMutation(async () => {
        if (!isQueueMutationOriginCurrent(origin)) return;
        // Gone, or never reached the server: there is nothing there to move.
        const liveUuids = new Set(stateRef.current.queue.map((queueItem) => queueItem.uuid));
        if (!isOnServer(uuid, liveUuids)) return;
        const wireOldIndex = serverIndexIn(previousQueue, uuid);
        const wireNewIndex = serverIndexIn(reorderedQueue, uuid);
        if (wireOldIndex === wireNewIndex) return;
        try {
          await mutations.reorderQueueItem(uuid, wireOldIndex, wireNewIndex);
        } catch (error) {
          if (!isQueueMutationOriginCurrent(origin)) return;
          if (__DEV__) console.warn('[queue] reorderQueueItem sync failed; rolling back', error);
          // Unlike add/remove (idempotent, converge on next sync), a failed reorder
          // would leave this client's order silently diverged from peers. Roll back
          // to the pre-reorder order — that matches the server, which never applied
          // the move — and surface the failure. Only while the queue is still
          // exactly what this move left: anything the climber did since would be
          // lost, so then the server's queue is fetched instead.
          showQueueMutationErrorToast(error, t, showToast);
          const live = stateRef.current;
          const untouchedSince =
            live.queue.length === reorderedQueue.length &&
            live.queue.every((queueItem, index) => queueItem.uuid === reorderedQueue[index].uuid);
          if (untouchedSince) {
            dispatch({
              type: 'UPDATE_QUEUE',
              payload: { queue: previousQueue, currentClimbQueueItem: live.currentClimbQueueItem },
            });
          } else {
            void resyncQueueAfterMutationFailure(origin);
          }
        }
      });
    },
    [
      mutations,
      showToast,
      t,
      captureQueueMutationOrigin,
      enqueueQueueMutation,
      isQueueMutationOriginCurrent,
      isOnServer,
      resyncQueueAfterMutationFailure,
      serverIndexIn,
    ],
  );

  /**
   * Jump a climb to the slot right behind the one on the wall.
   *
   * Three shapes, decided by `planPlayNext` against live state:
   * - not queued yet → a positional add (the cross-board gate still runs first,
   *   and `commitQueueAdd` re-derives the index after it, so a prompt that sat
   *   open while the queue moved can't land the climb in a stale slot)
   * - queued elsewhere → a MOVE, never a duplicate: a second copy would leave
   *   the crew deleting the stale one by hand
   * - already up next (or its own queue slot is on the wall) → no mutation,
   *   but still confirm. Silence would read as a dead button.
   * - the climb on the wall, named by climb only (a list row's swipe) → a
   *   repeat copy right behind it.
   */
  const playNext = useCallback(
    async ({
      item,
      queueItemUuid,
    }: {
      item: ClimbQueueItem;
      queueItemUuid?: string;
    }): Promise<'added' | 'moved' | 'unchanged' | 'cancelled'> => {
      const plan = planPlayNext(stateRef.current.queue, stateRef.current.currentClimbQueueItem, {
        queueItemUuid,
        climbUuid: item.climb.uuid,
      });

      if (plan.kind === 'move') {
        reorderQueue(plan.uuid, plan.oldIndex, plan.newIndex, { source: 'play-next' });
        showQueueAddedSnackbar({ kind: 'playNext' });
        return 'moved';
      }

      // The climb on the wall, asked for by climb rather than by its queue slot
      // (a list row's swipe): "play this next" can only mean "again", so a
      // fresh copy goes right behind it and the toast tells the truth. From its
      // own queue slot there is nothing to do, and the menus hide the action.
      if (plan.kind === 'unchanged' && !(plan.reason === 'is-current' && queueItemUuid === undefined)) {
        showQueueAddedSnackbar({ kind: 'playNext' });
        return 'unchanged';
      }

      return addToQueue(item, { placement: 'next' });
    },
    [addToQueue, reorderQueue, showQueueAddedSnackbar],
  );

  const applyQueueSnapshot = useCallback(
    (
      queue: ClimbQueueItem[],
      currentClimbQueueItem: ClimbQueueItem | null | undefined,
      origin: QueueMutationOrigin,
      deferredSnapshot?: () => QueueContentSnapshot | null,
    ) => {
      const commitSnapshot = (snapshot: QueueContentSnapshot) => {
        pendingUnsyncedCurrentRef.current = null;
        const existingUuids = new Set(stateRef.current.queue.map((queueItem) => queueItem.uuid));
        const attributedQueue = snapshot.queue.map((item) => attributeNewItem(item, existingUuids));
        const attributedCurrent = snapshot.currentClimbQueueItem
          ? (attributedQueue.find((item) => item.uuid === snapshot.currentClimbQueueItem?.uuid) ??
            attributeNewItem(snapshot.currentClimbQueueItem, existingUuids))
          : null;
        dispatch({
          type: 'UPDATE_QUEUE',
          payload: { queue: attributedQueue, currentClimbQueueItem: attributedCurrent },
        });
        return {
          queue: attributedQueue.filter((item) => isClimbResolved(item.climb)),
          current: attributedCurrent && isClimbResolved(attributedCurrent.climb) ? attributedCurrent : undefined,
        };
      };
      // Ordinary replacements stay optimistic. Undo waits until its removals
      // finish, then composes from live state immediately before setQueue reads
      // the server baseline. Crew changes during that wait stay in the payload.
      const optimistic = deferredSnapshot
        ? null
        : commitSnapshot({ queue, currentClimbQueueItem: currentClimbQueueItem ?? null });
      void enqueueQueueMutation(async () => {
        if (!isQueueMutationOriginCurrent(origin)) return;
        const snapshot = deferredSnapshot?.();
        if (deferredSnapshot && !snapshot) return;
        const prepared = snapshot ? commitSnapshot(snapshot) : optimistic;
        if (!prepared) return;
        try {
          await mutations.setQueue(prepared.queue, prepared.current);
        } catch (error) {
          if (!isQueueMutationOriginCurrent(origin)) return;
          if (__DEV__) console.warn('[queue] setQueue sync failed', error);
          reconcileFailedContentMutation(error, origin);
        }
      });
    },
    [attributeNewItem, enqueueQueueMutation, isQueueMutationOriginCurrent, mutations, reconcileFailedContentMutation],
  );

  // The wire half of a multi-item removal (clear, bulk remove). There is no
  // bulk-remove mutation, so it fans out per item, queued behind any send
  // already on the lane so the server sees the climber's order.
  //
  // ONE AT A TIME, for the reason `appendQueueItems` gives: each remove lands in
  // the backend's single-key Redis CAS with three retries and no backoff, so N
  // concurrent removes mostly exhaust their retries, the reconcile below resyncs,
  // and the "removed" climbs come back — while the Undo snackbar still says
  // they're gone. A failure doesn't stop the rest: each later item still goes,
  // in order.
  //
  // If any remove fails in a party session, the items may still live on peers —
  // reconcile once against the server and tell the user we refreshed. Solo: the
  // local removal is authoritative, so resync no-ops and no toast fires.
  const sendRemovalsOnLane = useCallback(
    (itemsToRemove: readonly ClimbQueueItem[], origin: QueueMutationOrigin) => {
      // Still on the server until each remove goes, which a move or Play next
      // queued ahead of them must count (`serverIndexIn`).
      const unsentRemovals = laneUnsentRemovalUuidsRef.current;
      for (const item of itemsToRemove) unsentRemovals.add(item.uuid);
      void enqueueQueueMutation(async () => {
        const failures: unknown[] = [];
        for (const item of itemsToRemove) {
          if (!isQueueMutationOriginCurrent(origin)) return;
          try {
            await mutations.removeQueueItem(item.uuid);
          } catch (error) {
            if (!isQueueMutationOriginCurrent(origin)) return;
            if (__DEV__) console.warn('[queue] removeQueueItem sync failed', error);
            failures.push(error);
          } finally {
            unsentRemovals.delete(item.uuid);
          }
        }
        if (!isQueueMutationOriginCurrent(origin)) return;
        if (failures.length === 0) return;
        // The limiter typically rejects only the tail, so prefer a throttled
        // reason over the first one — otherwise an unrelated early failure
        // would swallow the pacing hint.
        const throttledFailure = failures.find((error) => isRateLimitedError(error));
        reconcileFailedContentMutation(throttledFailure ?? failures[0], origin);
      });
    },
    [enqueueQueueMutation, isQueueMutationOriginCurrent, mutations, reconcileFailedContentMutation],
  );

  const clearQueue = useCallback(() => {
    const itemsToRemove = stateRef.current.queue;
    // Clear is a new queue intent. Cancel this provider's unsent appends, then
    // enqueue the removals behind any already-active send so the server observes
    // the same order as the climber's intent.
    invalidateQueuedQueueMutations();
    const origin = captureQueueMutationOrigin();
    // A whole-queue clear supersedes any deferred current re-broadcast (#3868).
    pendingUnsyncedCurrentRef.current = null;
    dispatch({ type: 'CLEAR_QUEUE' });
    track(SHARED_EVENTS.QueueCleared, { layoutId: activeBoardRef.current?.layoutId, totalCount: itemsToRemove.length });
    setPlaylistSuggestionSourceState(null);
    sendRemovalsOnLane(itemsToRemove, origin);
  }, [captureQueueMutationOrigin, invalidateQueuedQueueMutations, sendRemovalsOnLane]);

  // Remove several climbs at once (the queue sheet's edit-mode bulk remove).
  // Unlike N calls to `removeFromQueue`, the wire sends ride the serialized
  // queue lane, so a later `setQueue` — the sheet's Undo — is guaranteed to
  // reach the server AFTER these removes instead of racing them and being
  // deleted by a late one. One reconcile for the batch, like `clearQueue`.
  //
  // Trade-off, kept on purpose: these removes wait behind whatever is already
  // on the lane (a playlist append still draining), where `removeFromQueue`
  // sends at once. Unlike `clearQueue` this does NOT invalidate the queued work:
  // that would cancel the unsent adds of climbs the climber KEPT, which then
  // never reach the crew. A pending add of a climb removed here still goes out
  // first and the remove follows it, so the crew ends in the right state, one
  // round-trip later. The transport bounds each attempt and its retry count.
  const removeQueueItems = useCallback(
    (uuids: readonly string[]) => {
      const targets = new Set(uuids);
      const itemsToRemove = stateRef.current.queue.filter((queueItem) => targets.has(queueItem.uuid));
      if (itemsToRemove.length === 0) return;
      const origin = captureQueueMutationOrigin();
      const partyMode = countDistinctSessionUsers(sessionRuntimeStateRef.current?.users) > 1;
      for (const removedItem of itemsToRemove) {
        dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: removedItem.uuid } });
        track(SHARED_EVENTS.ClimbRemovedFromQueue, {
          climbUuid: removedItem.climb.uuid,
          queueItemUuid: removedItem.uuid,
          boardName: activeBoardRef.current?.boardType,
          layoutId: activeBoardRef.current?.layoutId,
          partyMode,
          removedBy: 'self',
        });
      }
      sendRemovalsOnLane(itemsToRemove, origin);
    },
    [captureQueueMutationOrigin, sendRemovalsOnLane],
  );

  // Replace the whole queue in one shot: optimistic local UPDATE_QUEUE (the
  // source of truth for the user's queue) + SET_QUEUE sync that no-ops in solo
  // and broadcasts to party peers when a session exists. In party mode a sync
  // failure would leave peers on the old queue, so reconcile like other failed
  // session mutations.
  //
  // Clamped to MAX_SYNCED_QUEUE_ITEMS as a backstop: `Mutation.setQueue` THROWS
  // on a longer payload (see packages/shared/queue/src/limits.ts). The window
  // keeps the current climb. Callers that can say what fit clamp first (the
  // playlist replace toasts it); this only stops a caller of `setQueue` that
  // forgot from sending a payload the server refuses. The session seed and
  // re-seed push the live queue themselves and clamp it the same way.
  const setQueue = useCallback(
    (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return;
      const syncableQueue = clampQueueAroundCurrent(queue, currentClimbQueueItem);
      invalidateQueuedQueueMutations();
      applyQueueSnapshot(syncableQueue, currentClimbQueueItem, captureQueueMutationOrigin());
    },
    [applyQueueSnapshot, captureQueueMutationOrigin, invalidateQueuedQueueMutations, privacyRevocationGeneration],
  );

  const restoreQueueItems = useCallback(
    (before: QueueContentSnapshot, removedUuids: ReadonlySet<string>, scope: string) => {
      const isCurrent = () =>
        scope === undoScopeRef.current && privacyRevocationGeneration === getPrivacyRevocationGeneration();
      if (!isCurrent()) return;
      const origin = captureQueueMutationOrigin();
      applyQueueSnapshot(before.queue, before.currentClimbQueueItem, origin, () => {
        if (!isCurrent()) return null;
        // A removal failure may have a pre-Undo HTTP snapshot still in flight.
        // Retire its ownership when this queued restore applies, so neither it
        // nor a coalesced trailing read can overwrite Undo. Keep the mutation
        // generation intact: pending appends of climbs we kept must still send.
        // Initial profile resolution keeps older null-identity origins valid;
        // retire those flights too, without cancelling any queued wire writes.
        resyncFlightsByOriginRef.current.clear();
        return restoreRemovedQueueItems(before, removedUuids, {
          queue: stateRef.current.queue,
          currentClimbQueueItem: stateRef.current.currentClimbQueueItem,
        });
      });
    },
    [applyQueueSnapshot, captureQueueMutationOrigin, privacyRevocationGeneration],
  );

  // Stable live read of the queue + current climb and masked playlist source.
  // Action-only consumers get the latest without subscribing to state renders.
  const getQueueSnapshot = useCallback(
    () => ({
      queue: stateRef.current.queue,
      currentClimbQueueItem: stateRef.current.currentClimbQueueItem,
      playlistSuggestionSource: playlistSuggestionSourceRef.current,
    }),
    [],
  );

  // Add a batch next to whatever the climber already has going, instead of
  // replacing it. Leaving the current pointer alone is what keeps the BLE
  // auto-sender (it writes state.currentClimbQueueItem) from repainting the wall
  // out from under someone mid-project, and adding rather than replacing keeps
  // their hand-queued climbs. Mirrors web's start-sesh-drawer.
  //
  // `placement` picks where the batch lands, in batch order: `'end'` (the
  // default) at the bottom of Up next, `'next'` at the top of it, in the slot a
  // single Play next takes (`playNextInsertPosition`), derived once here from
  // live state. Unlike a single Play next, a batch never MOVES a climb that is
  // already queued: it is a list going in as copies, the same as the append.
  //
  // `activateFirstWhenIdle` is the workout generator's contract — "start me on
  // the first climb of the session I just generated" — and defaults OFF, because
  // the other caller is the playlist Play next / Play last rows, where taking the
  // wall is exactly what the climber asked us not to do. It can only FILL an
  // empty pointer; it never moves one that is already set.
  //
  // Returns how many items actually landed, after the clamp below, so the caller
  // can confirm an honest count.
  const appendQueueItems = useCallback(
    (items: ClimbQueueItem[], options?: { activateFirstWhenIdle?: boolean; placement?: QueueAddPlacement }): number => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return 0;
      // Nothing to append: don't broadcast a SET_QUEUE that changes nothing.
      if (items.length === 0) return 0;
      const { queue, currentClimbQueueItem } = stateRef.current;
      // `Mutation.setQueue` THROWS on a payload longer than MAX_SYNCED_QUEUE_ITEMS
      // rather than truncating it, and an append is the one write that can cross
      // that line by addition — so clamp here and report what fit. Note the cap is
      // measured against the LOCAL queue: the server's copy can be longer if a
      // concurrent-add merge re-appended peer climbs on top of a full payload
      // (see the follow-up filed with this change).
      const remainingCapacity = MAX_SYNCED_QUEUE_ITEMS - queue.length;
      if (remainingCapacity <= 0) return 0;
      const appended = items.length > remainingCapacity ? items.slice(0, remainingCapacity) : items;

      const nextCurrent = currentClimbQueueItem ?? (options?.activateFirstWhenIdle ? appended[0] : null);
      // The first landing slot, or undefined for an append. Read against the
      // pointer as it stands before this call: an idle queue that the batch's
      // own first climb is about to take is still "nothing current", so a
      // Play next batch starts at the head either way.
      const insertPosition =
        options?.placement === 'next' ? playNextInsertPosition(queue, currentClimbQueueItem) : undefined;
      const origin = captureQueueMutationOrigin();
      if (nextCurrent) {
        const nextQueue =
          insertPosition === undefined
            ? [...queue, ...appended]
            : [...queue.slice(0, insertPosition), ...appended, ...queue.slice(insertPosition)];
        applyQueueSnapshot(nextQueue, nextCurrent, origin);
        return appended.length;
      }

      // Nothing is current and the caller did not ask to take the wall. A
      // wholesale `setQueue` cannot express "leave the current climb alone": the
      // resolver reads an absent pointer as a CLEAR and writes null into session
      // state for the whole crew (queue/mutations.ts setQueue →
      // roomManager.updateQueueState). An additive action must never be able to
      // blank a peer's wall, not even through a stale local mirror, so this batch
      // goes out as per-item adds instead — ADD_QUEUE_ITEM carries no pointer at
      // all, so the invariant holds by construction. (`clearQueue` fans out
      // per-item too, but for a different reason: there is no bulk-clear
      // mutation. What is borrowed from it is the reconcile shape below.)
      //
      // Attribution set hoisted once: `attributeNewItem` otherwise rescans the
      // whole queue per item, and this is the caller its `existingUuids`
      // parameter was written for — a playlist can hand over the entire board
      // list.
      const existingUuids = new Set(queue.map((queueItem) => queueItem.uuid));
      const attributedItems = appended.map((item) => attributeNewItem(item, existingUuids));
      // A Play next batch takes consecutive slots from `insertPosition`, so it
      // keeps the list's order at the head of Up next. The same index goes to
      // the local dispatch and the wire, as in `commitQueueAdd`, so this phone
      // and its peers agree on where each climb landed.
      const positionAt = (index: number) => (insertPosition === undefined ? undefined : insertPosition + index);
      attributedItems.forEach((item, index) => {
        dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item, position: positionAt(index) } });
      });
      // Drain the wire sends ONE AT A TIME. Every addQueueItem lands in the
      // backend's `withQueueVersionRetry` around a single-key Redis CAS, with a
      // 3-attempt ceiling and no backoff or jitter — so firing N of them at once
      // means each attempt wins with roughly 1/N probability and most of a batch
      // exhausts its retries. Three things would break at once: peers receive a
      // fraction of the playlist, they receive it in CAS-resolution order rather
      // than playlist order (no `position` is sent — the server appends), and the
      // ordered-hash watchdog then collapses THIS device's queue to whatever
      // landed, losing climbs the snackbar already confirmed. Sequential sends
      // are uncontended and arrive in order; the local queue is already correct,
      // so the latency is invisible.
      void enqueueQueueMutation(async () => {
        const failures: unknown[] = [];
        // Counts the climbs the server has taken at the head, so a skipped
        // (removed) or failed climb doesn't leave a gap in the positions of the
        // ones after it. A single positional add or a move waits behind this
        // drain on the same lane (`commitQueueAdd`, `reorderQueue`), so nothing
        // else from this phone lands among these slots while it runs.
        let sentCount = 0;
        for (const item of attributedItems) {
          if (!isQueueMutationOriginCurrent(origin)) return;
          // A later per-item removal is an explicit user choice even if it
          // landed while this item was waiting behind an earlier append.
          if (mutations.wasUuidExplicitlyRemoved(item.uuid)) continue;
          try {
            await mutations.addQueueItem(item, positionAt(sentCount));
            // Only a climb the server took moves the next one along. A failed
            // send leaves its slot empty on the server, so the next climb takes it.
            sentCount += 1;
            laneFailedAddUuidsRef.current.delete(item.uuid);
          } catch (error) {
            if (!isQueueMutationOriginCurrent(origin)) return;
            // Still in this phone's queue but not the server's: a move queued
            // behind this drain must not count it (`serverIndexIn`).
            laneFailedAddUuidsRef.current.add(item.uuid);
            if (__DEV__) console.warn('[queue] appendQueueItems addQueueItem sync failed', error);
            failures.push(error);
          }
        }
        if (!isQueueMutationOriginCurrent(origin)) return;
        if (failures.length === 0) return;
        // ONE reconcile for the batch, not one per item: each call can toast and
        // kick a resync, so 30 failed adds would be 30 toasts. Prefer a throttled
        // reason over the first — a burst typically only trips the limiter at the
        // tail, and an unrelated early failure would otherwise swallow the pacing
        // hint. Same rule as `clearQueue`.
        const throttledFailure = failures.find((error) => isRateLimitedError(error));
        reconcileFailedContentMutation(throttledFailure ?? failures[0], origin);
      });
      return appended.length;
    },
    [
      privacyRevocationGeneration,
      applyQueueSnapshot,
      attributeNewItem,
      captureQueueMutationOrigin,
      enqueueQueueMutation,
      isQueueMutationOriginCurrent,
      mutations,
      reconcileFailedContentMutation,
    ],
  );

  // A throttled setCurrentClimb that carried `shouldAddToQueue` lost two
  // changes, not one. The pointer move self-heals (the next activation or any
  // peer broadcast re-establishes it), but the brand-new queue slot the reducer
  // optimistically inserted does not: no later activation retroactively adds
  // the skipped item, so it would sit in this climber's queue and nobody
  // else's, forever. Re-send just the content half as its own ADD_QUEUE_ITEM —
  // `execute` gives it a fresh rate-limit back-off budget, the server's add is
  // idempotent by uuid, and it leaves the current pointer alone, so the climb
  // reaches the crew without the yank-back a resync would cause (#2763).
  //
  // Three outcomes, decided by whether the slot is still in the local queue and,
  // when it isn't, by the shared removal ledger (#4009):
  //   still queued           -> positioned ADD (peers see our order)
  //   gone, climber removed  -> nothing (don't resurrect their discard)
  //   gone, wholesale sync   -> unpositioned ADD (server appends; the crew still
  //                             gets the climb instead of nobody getting it)
  const recoverThrottledQueueAdd = useCallback(
    async (item: ClimbQueueItem, origin: QueueMutationOrigin) => {
      // Capture the session this slot belongs to. Every leg below runs after an
      // await, and the undo leg in particular can wake up in a DIFFERENT session
      // (the climber ended this one and joined another while the add was backing
      // off) — a remove aimed at that session is aimed at the wrong crew's queue.
      // Same discipline the coalescer applies to its own deferred sends.
      const recoverySessionId = origin.sessionId;
      if (!recoverySessionId || !isQueueMutationOriginCurrent(origin)) return;
      // `origin` was captured when the activation started. The live session ref
      // can point to a different room after this mutation's rate-limit backoff.
      // Keep every recovery and compensation step behind that same origin fence.
      // Position the re-send where the optimistic insert actually landed
      // (insert-after-current, #2217) so peers see the same order we do. The
      // server clamps an out-of-range position to an append.
      const position = stateRef.current.queue.findIndex((queueItem) => queueItem.uuid === item.uuid);
      // Gone locally. Two reasons, and only one of them means "don't send"
      // (#4009) — the same fork the shared coalescer's sendDeferredQueueAdd
      // makes, read off the ledger it already keeps rather than re-derived here:
      //   - the climber dropped it (a swipe-remove, a clear, a playlist replace)
      //     → honour that; a bare ADD resurrects a climb they just discarded.
      //   - a wholesale server sync replaced the queue → the activation that
      //     started this burst was itself an add, so the server answered it with
      //     a FullSync, and INITIAL_QUEUE_DATA applies that by REPLACING the
      //     queue, wiping the not-yet-synced optimistic slot. Bailing here is
      //     the bug: the climb reaches nobody. Send it WITHOUT a position — the
      //     server appends, no worse than the pre-#3934 behaviour, and the crew
      //     at least gets the climb.
      if (position === -1 && mutations.wasUuidExplicitlyRemoved(item.uuid)) return;
      try {
        await mutations.addQueueItem(item, position === -1 ? undefined : position);
      } catch (error) {
        if (__DEV__) console.warn('[queue] throttled setCurrentClimb queue-add recovery failed', error);
        // The slot never reached the server even with its own retry budget, so
        // this client really has diverged. Fall back to the same reconciliation
        // every other content mutation uses — a refreshed queue beats one
        // that's permanently local-only.
        if (isQueueMutationOriginCurrent(origin)) void resyncQueueAfterMutationFailure(origin);
        return;
      }
      // The add can sit in `execute`'s rate-limit back-off for seconds. If the
      // climber dropped the climb inside that window their remove raced ahead
      // of this add, so the slot we just landed is back on the whole crew's
      // queue. The local queue is the record of intent — undo it rather than
      // leave a climb nobody asked for. Only while we're still in the session
      // the add went to: after a session swap the local queue describes the new
      // room, and its lack of this item says nothing about the old one.
      if (!isQueueMutationOriginCurrent(origin)) return;
      if (stateRef.current.queue.some((queueItem) => queueItem.uuid === item.uuid)) return;
      // Absence alone is not intent (#4009). A wholesale sync wipes the slot
      // locally while the add lands server-side, and undoing on that reading
      // both deletes a climb the picker did choose and writes its uuid into the
      // shared removal ledger, which then suppresses any later legitimate
      // deferred add for it. Only a ledger hit — a real remove / clear /
      // wholesale replace by this climber — is a reason to compensate.
      if (!mutations.wasUuidExplicitlyRemoved(item.uuid)) return;
      mutations.removeQueueItem(item.uuid).catch((error) => {
        if (__DEV__) console.warn('[queue] undoing a resurrected queue-add failed', error);
        if (isQueueMutationOriginCurrent(origin)) void resyncQueueAfterMutationFailure(origin);
      });
    },
    [isQueueMutationOriginCurrent, mutations, resyncQueueAfterMutationFailure],
  );

  // Forget the pending re-send and its fallback timer: both are empty from here.
  const forgetPendingResend = useCallback(() => {
    moveResendRef.current = null;
    if (moveResendFallbackTimerRef.current) {
      clearTimeout(moveResendFallbackTimerRef.current);
      moveResendFallbackTimerRef.current = null;
    }
  }, []);

  // Hand the queue slots a pending re-send was holding back to their own
  // recovery, and forget it. Called when the move is given up before its
  // re-send (a newer move, a crewmate's move, the TTL, a room change) and right
  // after the re-send goes out.
  const releasePendingResend = useCallback(() => {
    const pending = moveResendRef.current;
    if (!pending) return;
    forgetPendingResend();
    for (const queueAdd of pending.queueAdds) void recoverThrottledQueueAdd(queueAdd, pending.origin);
  }, [forgetPendingResend, recoverThrottledQueueAdd]);

  // Re-send a slot a lost send added, unless a move's re-send is still pending:
  // then it waits with that move (see moveResendRef).
  const queueOrRecoverMoveAdd = useCallback(
    (item: ClimbQueueItem, origin: QueueMutationOrigin) => {
      const pending = moveResendRef.current;
      if (pending) {
        pending.queueAdds.push(item);
        return;
      }
      void recoverThrottledQueueAdd(item, origin);
    },
    [recoverThrottledQueueAdd],
  );

  // Every way a setCurrentClimb can fail, for both the call's own rejection and
  // a drained send (see onSetCurrentClimbDrainError).
  //
  // A send that MISSED the session (moveMissedTheSession) is not a divergence:
  // the server never ran it, so nobody's wall moved. Resyncing there pulled the
  // wall back to the previous climb under the climber and toasted "out of sync"
  // (#6783 QA, a backend deploy mid-session). Instead:
  //   - the climber's latest move is re-sent once, after the live stream's
  //     snapshot proves nothing happened in the session since (the reducer
  //     marks the unconfirmed move `ready`, the effect below sends it), or
  //     given up the old way if that snapshot does not come in time;
  //   - an older send, already superseded on screen, changes nothing; only a
  //     queue slot it added still needs to reach the crew (see moveResendRef);
  //   - a send whose move a snapshot or a crewmate's move already retired
  //     needs no resync either (the wall shows the session's climb), only the
  //     "out of sync" toast that resync would have shown.
  // Every other failure, and a re-send that fails again, keeps the behaviour it
  // always had, after retiring the move so the next snapshot is the truth.
  const handleSetCurrentClimbFailure = useCallback(
    (
      error: unknown,
      { item, shouldAddToQueue, correlationId, origin, sentAtSequence, drained }: SetCurrentClimbFailure,
    ): boolean => {
      if (!isQueueMutationOriginCurrent(origin)) return false;
      const { unconfirmedMove, currentClimbQueueItem, serverSequence } = stateRef.current;
      const isLatestSend = unconfirmedMove?.correlationId === correlationId;
      const missedTheSession = origin.sessionId !== null && moveMissedTheSession(error);
      if (missedTheSession) {
        // A chain too long to compare with a snapshot (movedOffTruncated) has
        // nothing to wait for: every snapshot wins, so it is given up the old
        // way below rather than undone without a word.
        if (
          unconfirmedMove &&
          isLatestSend &&
          unconfirmedMove.resend === 'none' &&
          !unconfirmedMove.movedOffTruncated
        ) {
          // A move still waiting for its own re-send is history now; its slots
          // go out on their own.
          releasePendingResend();
          moveResendRef.current = {
            correlationId,
            itemUuid: item.uuid,
            origin,
            parkedAtSequence: serverSequence,
            // The re-send carries the add itself; this is in case it never goes.
            // A drained one's too: the coalescer leaves it to us (see the
            // return below), because its own re-send would land before the
            // rejoin snapshot is read.
            queueAdds: shouldAddToQueue ? [item] : [],
          };
          // The wait starts now: keep the echo's correlation id alive past it.
          coordinator.trackPendingMutation(correlationId);
          dispatch({
            type: 'UNCONFIRMED_MOVE_NOT_SENT',
            payload: {
              correlationId,
              // Once the bound connection's stream has opened with a FullSync,
              // every crewmate's move reaches this phone live, and one would
              // already have retired the move. Before that, wait for it.
              serverViewIsLive: queueStreamLiveRef.current,
            },
          });
          if (moveResendFallbackTimerRef.current) clearTimeout(moveResendFallbackTimerRef.current);
          // Only a move that can wait gets here: the branch above leaves out a
          // truncated chain (movedOffTruncated). Every snapshot wins against
          // one, so it would be retired before this fires, and this fallback,
          // the only resync on this path, would then never run. Keep that rule
          // in the branch condition; "gives a lost move up at once when its
          // chain is too long to compare" pins it.
          moveResendFallbackTimerRef.current = setTimeout(() => {
            moveResendFallbackTimerRef.current = null;
            const waiting = stateRef.current.unconfirmedMove;
            if (waiting?.correlationId !== correlationId || waiting.resend !== 'awaiting-snapshot') return;
            if (!isQueueMutationOriginCurrent(origin)) return;
            // The session never came back for it: the old reconciliation, late.
            dispatch({ type: 'UNCONFIRMED_MOVE_DROPPED', payload: { correlationId } });
            void resyncQueueAfterMutationFailure(origin);
          }, MOVE_RESEND_WAIT_MS);
          return shouldAddToQueue;
        }
        // A newer send (of this climb or another) is on its way: this send's
        // pointer half is moot, so no resync and no toast.
        const supersededByNewerSend = !isLatestSend && unconfirmedMove != null;
        // No newer send, and the record is gone with the wall on another climb.
        // The wall already shows what the session holds, so no resync either.
        const wallMovedOff = unconfirmedMove == null && currentClimbQueueItem?.uuid !== item.uuid;
        if (supersededByNewerSend || wallMovedOff) {
          // A slot it added still has to reach the crew, held back while a
          // re-send is pending. A drained one's too, instead of the coalescer.
          if (shouldAddToQueue) queueOrRecoverMoveAdd(item, origin);
          // A snapshot or a crewmate's move retired the record before this
          // failure arrived: the wall went back without a tap, so say so, as
          // the resync this replaced did. A server change is the one way the
          // sequence moves on; without one, this climber moved the wall again
          // without a send (an unresolved climb), and that needs no word.
          if (wallMovedOff && serverSequence !== sentAtSequence) {
            showToast(t('mobile.queue.outOfSyncRefreshed'), 'error');
          }
          return shouldAddToQueue;
        }
      }
      // This move is not coming. Stop protecting it so the next snapshot wins.
      if (isLatestSend) dispatch({ type: 'UNCONFIRMED_MOVE_DROPPED', payload: { correlationId } });
      // A drained send has always been best-effort: the coalescer re-sends its
      // queue-add, and the hash watchdog reconciles the pointer.
      if (drained) return false;
      // A slot a lost send added would otherwise vanish in the resync below.
      if (missedTheSession && shouldAddToQueue) void recoverThrottledQueueAdd(item, origin);
      // A throttled POINTER move is not a divergence: the rate-limit gate
      // throws before the resolver runs, so the server still holds the climb
      // it held a moment ago and the next activation (or any peer's
      // broadcast) re-establishes it. Resyncing here would yank the user back
      // to the previous boulder mid-swipe and fire another query into the
      // limiter that just throttled us — which is what #2763 was reported as
      // ("the connection fails every time we try to switch boulders"). Show
      // the gentle "slow down" toast instead and leave the local pointer put.
      const throttled = isRateLimitedError(error);
      if (sessionIdRef.current && !throttled) {
        // Any other party-session failure means peers really did diverge —
        // reconcile against the server (and toast that we refreshed).
        void resyncQueueAfterMutationFailure(origin);
        return false;
      }
      // Throttled while ALSO adding a fresh climb to the queue: the pointer
      // half self-heals, the new slot doesn't. Re-send it on its own so the
      // content change isn't stranded locally (solo no-ops — its queue is
      // authoritative and there's no server to fall behind).
      if (throttled && shouldAddToQueue) {
        void recoverThrottledQueueAdd(item, origin);
      }
      // Solo (no server to reconcile) and the rate-limited party case both
      // land here: toast only, no resync.
      showQueueMutationErrorToast(error, t, showToast);
      return false;
    },
    [
      coordinator,
      isQueueMutationOriginCurrent,
      queueOrRecoverMoveAdd,
      recoverThrottledQueueAdd,
      releasePendingResend,
      resyncQueueAfterMutationFailure,
      showToast,
      t,
    ],
  );
  handleSetCurrentClimbFailureRef.current = handleSetCurrentClimbFailure;

  // Send one SET_CURRENT_CLIMB, from a fresh activation or a re-send.
  const sendCurrentClimb = useCallback(
    (item: ClimbQueueItem, shouldAddToQueue: boolean, correlationId: string, origin: QueueMutationOrigin) => {
      // (Re)start the echo's TTL: a re-send's echo can come well after the
      // first send's window opened.
      coordinator.trackPendingMutation(correlationId);
      const sentAtSequence = stateRef.current.serverSequence;
      const sends = moveSendsRef.current;
      sends.delete(correlationId);
      sends.set(correlationId, { origin, sentAtSequence });
      if (sends.size > MAX_TRACKED_MOVE_SENDS) {
        const oldest = sends.keys().next().value;
        if (oldest !== undefined) sends.delete(oldest);
      }
      mutations.setCurrentClimb(item, shouldAddToQueue, correlationId).catch((error: unknown) => {
        handleSetCurrentClimbFailure(error, {
          item,
          shouldAddToQueue,
          correlationId,
          origin,
          sentAtSequence,
          drained: false,
        });
      });
    },
    [coordinator, handleSetCurrentClimbFailure, mutations],
  );

  // Optimistic local dispatch + correlated SET_CURRENT_CLIMB mutation. The
  // reducer stores `correlationId` in pendingCurrentClimbUpdates so the echoed
  // CurrentClimbChanged event (same id in `serverCorrelationId`) is suppressed
  // instead of re-applied.
  const dispatchSetCurrent = useCallback(
    (
      rawItem: ClimbQueueItem,
      shouldAddToQueue: boolean,
      playlistSuggestionSource?: PlaylistSuggestionSource | null,
      insertAfterCurrent?: boolean,
      suppliedCorrelationId?: string,
    ) => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return;
      // Activating a climb that isn't in the queue yet (shouldAddToQueue, or the
      // playlist peek minted in nextClimb) introduces it — stamp it before the
      // dispatch so state and broadcast agree. Navigating onto an item already in
      // the queue is a no-op here: attributeNewItem sees the uuid and leaves it
      // alone, so stepping through the crew's queue never re-authors it (#3995).
      const item = attributeNewItem(rawItem);
      const correlationId = suppliedCorrelationId ?? coordinator.generateCorrelationId();
      // Skip the broadcast for an unresolved climb (#2527), see below.
      const broadcasts = isClimbResolved(item.climb);
      dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        // playlistSuggestionSource is client-only state — when present the
        // reducer sets it + prunes suggested-after-current; when undefined it's
        // left unchanged. It is intentionally NOT sent to the server mutation.
        // insertAfterCurrent keeps the optimistic queue in step with the server
        // (issue #2217): a newly activated climb slots in right after the
        // current climb, not at the end.
        // pruneSuggestedAfterCurrent: the browse-origin prune (list taps and
        // committed peeks are `suggested`) never reaches the server, so inside a
        // party session it would only make this phone's queue disagree with the
        // room's — the ordered-hash watchdog would flag drift and resync the
        // leftovers straight back. List-first swipes (#4829) don't need the
        // prune for correctness, so it runs solo-only; in a session the crew's
        // queue stays exactly as the server holds it.
        // sessionId: the room this move is sent to, so the reducer keeps it
        // through a snapshot of that room that predates it. Only when a
        // mutation really goes out (resolved climb, in a session).
        payload: {
          item,
          shouldAddToQueue,
          isServerEvent: false,
          correlationId,
          playlistSuggestionSource,
          insertAfterCurrent,
          pruneSuggestedAfterCurrent: sessionIdRef.current == null,
          sessionId: broadcasts ? (sessionIdRef.current ?? undefined) : undefined,
        },
      });
      // Skip the broadcast for an unresolved climb (#2527) — a placeholder
      // ClimbInput can't be sent (its uuid may be empty and name/frames are
      // required server-side), and next/previousClimb can navigate onto a
      // not-yet-hydrated peer item. The local reducer already applied the change,
      // and useQueueResolveClimbs hydrates the item within a tick. No pending
      // correlation is tracked since no server echo will arrive. Remember the slot
      // AND the session it belongs to so the re-broadcast effect fires once it
      // hydrates while still current, but only back into the same room (#3868).
      if (!broadcasts) {
        if (__DEV__) console.warn('[queue] skipping setCurrentClimb sync for an unresolved climb. See #2527.');
        pendingUnsyncedCurrentRef.current = { queueItemUuid: item.uuid, sessionId: sessionIdRef.current };
        return;
      }
      // A real broadcast supersedes any deferred one — drop it so a late hydrate
      // of the previously-skipped slot can't re-broadcast an item we've moved off.
      pendingUnsyncedCurrentRef.current = null;
      // The account, room and queue generation this activation is aimed at. A
      // throttled setCurrentClimb can sit in back-off long enough for the
      // climber to change origin before recovery runs (#4009).
      sendCurrentClimb(item, shouldAddToQueue, correlationId, captureQueueMutationOrigin());
    },
    [privacyRevocationGeneration, attributeNewItem, captureQueueMutationOrigin, coordinator, sendCurrentClimb],
  );

  // Re-send a move whose send missed the session, once the reducer says the
  // live stream's snapshot shows nothing happened since (`resend: 'ready'`).
  // One re-send per move: it goes out with the move's own correlation id, so
  // its echo is suppressed like the original's, and the reducer moves the
  // record to `resent` before it leaves.
  const moveAwaitingResend = state.unconfirmedMove;
  useEffect(() => {
    const pending = moveResendRef.current;
    // The move a re-send was waiting for is gone (a newer move, a crewmate's
    // move, the TTL, the fallback): it will not be re-sent, so its slots go out
    // on their own now.
    if (pending && moveAwaitingResend?.correlationId !== pending.correlationId) {
      // Was it the session that undid it (a snapshot taken over it, a
      // crewmate's move), rather than this climber's own next move or edit?
      // Then the wall just went back without a tap: say so, as the resync this
      // replaced did. A server change is the one way the sequence moves on.
      const { serverSequence, currentClimbQueueItem } = stateRef.current;
      const undoneBySession =
        !moveAwaitingResend &&
        currentClimbQueueItem?.uuid !== pending.itemUuid &&
        serverSequence !== pending.parkedAtSequence &&
        isQueueMutationOriginCurrent(pending.origin);
      releasePendingResend();
      if (undoneBySession) showToast(t('mobile.queue.outOfSyncRefreshed'), 'error');
      return;
    }
    if (moveAwaitingResend?.resend !== 'ready') return;
    const { correlationId } = moveAwaitingResend;
    // Already on its way: this run only saw a commit that predates the
    // reducer's `resent`. Never a second send.
    if (resentMoveCorrelationIdRef.current === correlationId) return;
    // The wall's own copy of the climb: anything done to it locally since the
    // first send (a mirror, a hydrate) goes with it. The record only lives
    // while that climb is current, so this is always the move's climb.
    const current = stateRef.current.currentClimbQueueItem;
    if (
      !pending ||
      pending.correlationId !== correlationId ||
      pending.origin.sessionId !== moveAwaitingResend.sessionId ||
      !isQueueMutationOriginCurrent(pending.origin) ||
      privacyRevocationGeneration !== getPrivacyRevocationGeneration() ||
      current?.uuid !== moveAwaitingResend.itemUuid
    ) {
      // The room, account or queue intent changed while it waited. The move
      // belongs to that origin; let the next snapshot decide.
      forgetPendingResend();
      dispatch({ type: 'UNCONFIRMED_MOVE_DROPPED', payload: { correlationId } });
      return;
    }
    resentMoveCorrelationIdRef.current = correlationId;
    dispatch({ type: 'UNCONFIRMED_MOVE_RESENT', payload: { correlationId } });
    sendCurrentClimb(current, moveAwaitingResend.shouldAddToQueue, correlationId, pending.origin);
    // The re-send carries the move's own add; anything a superseded lost send
    // added goes now. From here nothing is pending: the ref and timer are empty.
    pending.queueAdds = pending.queueAdds.filter((queueAdd) => queueAdd.uuid !== current.uuid);
    releasePendingResend();
  }, [
    moveAwaitingResend,
    forgetPendingResend,
    isQueueMutationOriginCurrent,
    privacyRevocationGeneration,
    releasePendingResend,
    sendCurrentClimb,
    showToast,
    t,
  ]);

  // Re-broadcast the current climb once a deferred thin item hydrates (#3868).
  // dispatchSetCurrent skips the broadcast when it lands on an unresolved climb
  // (a peer item advanced onto before it synced), recording the slot in
  // pendingUnsyncedCurrentRef. useQueueResolveClimbs then hydrates that slot via
  // DELTA_REPLACE_QUEUE_ITEM, which the reducer also writes onto the current
  // climb (new identity, real name/frames) — this effect re-runs on that change.
  // Re-broadcasting here is the only path that tells peers, late joiners, and a
  // peer-held wall LED link (which follows THEIR local current, updated solely by
  // our broadcast) to advance. Without it they stay on the old climb until the
  // next navigation.
  const pendingUnsyncedCurrent = pendingUnsyncedCurrentRef.current;
  useEffect(() => {
    const pending = pendingUnsyncedCurrent;
    // An older passive effect must not retire a newer activation that has not
    // committed yet (for example during cold-start persistence completion).
    if (!pending || pending !== pendingUnsyncedCurrentRef.current) return;
    // Room changed since we deferred (a session join/switch/leave). Read
    // sessionIdRef, not `sessionId` state: joinSession / createSessionWithConfig
    // write the ref synchronously before setSessionId, so this pending effect can
    // flush after the ref already points at the new room but before the
    // [sessionId] backstop clear runs (PR #3894 Codex thread 3). Bailing on the
    // synchronous ref value stops the old room's climb leaking into the new one.
    if (pending.sessionId !== sessionIdRef.current) {
      pendingUnsyncedCurrentRef.current = null;
      return;
    }
    const current = state.currentClimbQueueItem;
    // Current moved off the deferred slot (local nav, a peer's server-driven
    // CurrentClimbChanged, or a removal) — drop the deferral so a stale hydrate
    // can't re-broadcast an item the session already moved past.
    if (!current || current.uuid !== pending.queueItemUuid) {
      pendingUnsyncedCurrentRef.current = null;
      return;
    }
    // Still thin — wait for hydration. isClimbResolved mirrors dispatchSetCurrent's
    // skip guard exactly (a still-unresolved item can't form a valid ClimbInput).
    if (!isClimbResolved(current.climb)) return;

    // Hydrated while still current: re-broadcast through the normal local path.
    // dispatchSetCurrent dispatches a LOCAL DELTA_UPDATE_CURRENT_CLIMB with a
    // fresh correlationId FIRST — for an already-current item that lands in the
    // reducer's same-uuid branch, which now seeds the id into
    // pendingCurrentClimbUpdates so the server echo of THIS re-broadcast is
    // suppressed instead of re-applied. (A raw mutation with only
    // trackPendingMutation would never seed the id, so the echo would apply
    // unsuppressed and could revert a newer navigation.) It also clears the
    // deferral ref, no-ops in solo via the shared coalescer, and reuses the same
    // failure handling. shouldAddToQueue is false: the slot is already queued.
    dispatchSetCurrent(current, false);
  }, [state.currentClimbQueueItem, dispatchSetCurrent, pendingUnsyncedCurrent]);

  /**
   * Store where the list picks up after a step into or out of Up next (#6777).
   * A walk that steps from a list climb into the queue records that list climb
   * on the track, and stepping back onto the list clears it: that is what keeps
   * the list's place while queued climbs play, and what tells the player to
   * say "Up next · 1 of 3" instead of the list's name.
   *
   * Written onto the held track only while it is still the one the step walked
   * (same list, tap and board), so a track replaced meanwhile is left alone.
   * The same render batch commits it with the current climb, so there is no
   * render in which the queued climb is current and the track has gone dormant.
   */
  const storeTrackResume = useCallback(
    (walkedSource: PlaylistSuggestionSource | null, trackResume: PlaylistTrackResume | null | undefined) => {
      if (trackResume === undefined || !walkedSource) return;
      if (samePlaylistTrackResume(walkedSource.resume, trackResume)) return;
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return;
      setPlaylistSuggestionSourceState((held) =>
        held && playlistSuggestionSourceMatches(held, walkedSource) ? withPlaylistTrackResume(held, trackResume) : held,
      );
    },
    [privacyRevocationGeneration],
  );

  const setCurrentClimb = useCallback(
    (item: ClimbQueueItem, options?: SetCurrentClimbOptions) => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return;
      // Source is client-only provider state (see note above) — set it whenever
      // the caller passes options. Activation passes a source; a fresh
      // climb-list/search open passes null to clear playlist context; re-opening
      // the current climb passes nothing, leaving the source intact.
      if (options?.playlistSuggestionSource !== undefined) {
        setPlaylistSuggestionSourceState(options.playlistSuggestionSource);
      }
      // A look that walked the queue went up on the wall (#6777). Read before the
      // dispatch, against the climb still current: Up next on the held track
      // keeps the list's place, as Next stepping into Up next does.
      if (options?.keepTrackIfUpNext) {
        const { queue, currentClimbQueueItem } = stateRef.current;
        const heldTrack = playlistSuggestionSourceRef.current;
        const trackResume = resolveUpNextCommitResume(queue, currentClimbQueueItem, heldTrack, item);
        if (trackResume === undefined) setPlaylistSuggestionSourceState(null);
        else storeTrackResume(heldTrack, trackResume);
      }
      // A spray wall's layout id is minted per wall, so `layoutId` cannot say
      // "spray". The board type can, and it is one of nine values. It is the
      // CLIMB's board, the same thing `Tick Logged` reports: a spray climb
      // opened from a shared link while a Kilter is the active board is a spray
      // climb, and a new account with no board bound yet still has one to name.
      // The active board is the fallback for a climb that does not carry one.
      const climbBoardType = boardTypeProperty(item.climb.boardType);
      track(SHARED_EVENTS.SetActiveClimb, {
        climbUuid: item.climb.uuid,
        layoutId: activeBoardRef.current?.layoutId,
        ...(climbBoardType.boardType ? climbBoardType : boardTypeProperty(activeBoardRef.current?.boardType)),
        // `climb_saved` when the create screen queued a climb it just saved,
        // null when a climber chose the climb. Saving is not climbing, so the
        // spray-wall activation measure reads only the null ones.
        trigger: options?.trigger ?? null,
        source: 'mobile',
        // Which crew's wall just moved, and how many people were watching it.
        // The preview-first work turns this event into the ONE deliberate act
        // that drives a shared wall (every browse-shaped gesture stopped firing
        // it), so without these two the "did people stop stepping on each
        // other" question has no numerator. `sessionId` is a room id, not a
        // person; the count is distinct humans, matching how `partyMode` is
        // stamped on Climb Added to Queue rather than raw connection rows.
        sessionId: sessionIdRef.current,
        participantCount: countDistinctSessionUsers(sessionRuntimeStateRef.current?.users),
      });
      // Activating a climb slots it right after the current climb (issue #2217),
      // pushing the current climb into history — matching the local "set climb
      // active" intent instead of bumping the new climb to the bottom. Fresh-uuid
      // items add to the queue; the reducer's uuid dedup makes re-selecting an
      // existing queue item a no-op add. During a playlist forward-swipe the
      // current climb is already the queue tail, so insert-after-current is
      // equivalent to append there and the "queue grows 1..10, 1..10" pass
      // (driven by findNextQueueItemWithSuggestions anchoring on the current
      // climb) is preserved.
      dispatchSetCurrent(item, true, options?.playlistSuggestionSource, true);
    },
    [dispatchSetCurrent, privacyRevocationGeneration, storeTrackResume],
  );

  // The editor saved a climb that is already in the queue. See the reducer's
  // REFRESH_AUTHORED_CLIMB for why this is not folded into setCurrentClimb.
  const refreshAuthoredClimb = useCallback(
    (climbUuid: string, patch: ClimbAuthoredPatch) => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return;
      dispatch({ type: 'REFRESH_AUTHORED_CLIMB', payload: { climbUuid, patch } });
    },
    [privacyRevocationGeneration],
  );

  // One skip run gets one notice. A held swipe can fire nextClimb twice for the
  // same current item before the dispatch commits — that is one run — so latch
  // it here and clear the latch whenever the current climb changes, which is the
  // only thing that makes a genuinely new run possible. (Keying the latch on the
  // item swiped away FROM would go silent on forward-back-forward, and would
  // collapse every no-current-climb run onto one key.)
  //
  // The latch is also what makes it safe that the forward selection is computed
  // TWICE per swipe against two different snapshots: `forwardSelection` below is
  // a useMemo over reactive state (it drives the dead-end notice), while
  // `nextClimb` recomputes from refs at gesture time (it must act on the very
  // latest queue, not on a render that may be a tick behind). The two can
  // disagree in the window between a dispatch and its commit, so whichever
  // reaches a skip run first reports it and the other stays quiet.
  const currentQueueItemUuid = state.currentClimbQueueItem?.uuid;
  const skipRunReportedForCurrentRef = useRef(false);
  useEffect(() => {
    skipRunReportedForCurrentRef.current = false;
  }, [currentQueueItemUuid]);

  const trackClimbsSkippedOnBoard = useCallback(
    (skippedItems: ClimbQueueItem[], landedOn: ClimbQueueItem | null, trigger: 'swipe' | 'queue_dead_end') => {
      const [firstSkipped] = skippedItems;
      track(SHARED_EVENTS.QueueClimbSkippedOnBoardSwitch, {
        boardName: activeBoardRef.current?.boardType,
        layoutId: activeBoardRef.current?.layoutId,
        sizeId: activeBoardRef.current?.sizeId,
        skippedCount: skippedItems.length,
        skippedClimbUuid: firstSkipped.climb.uuid,
        skippedClimbBoardType: firstSkipped.climb.boardType,
        skippedClimbLayoutId: firstSkipped.climb.layoutId ?? undefined,
        advancedToClimbUuid: landedOn?.climb.uuid ?? null,
        advancedToSuggestion: landedOn ? isPlaylistPeekQueueItemUuid(landedOn.uuid) : false,
        trigger,
        inSession: sessionIdRef.current != null,
      });
    },
    [],
  );

  /**
   * Tell the climber a forward swipe walked past queued climbs this board can't
   * draw (issue #5099), and record it. Called for every forward navigation; a
   * run that skipped nothing reports nothing.
   */
  const reportClimbsSkippedOnBoardSwitch = useCallback(
    (skippedItems: ClimbQueueItem[], landedOn: ClimbQueueItem | null) => {
      if (skippedItems.length === 0 || skipRunReportedForCurrentRef.current) return;
      skipRunReportedForCurrentRef.current = true;
      trackClimbsSkippedOnBoard(skippedItems, landedOn, 'swipe');
      showToast(
        tSettings('boardConfigMismatch.skippedOnBoardSwitchToast', {
          count: skippedItems.length,
          name: skippedItems[0].climb.name,
        }),
        'info',
      );
    },
    [showToast, tSettings, trackClimbsSkippedOnBoard],
  );

  // The swipe path cannot explain itself when the swipe is the thing that is
  // disabled: with every remaining queued climb off-board and no feed to fall
  // through to, `canNext` is false, so neither the gesture nor the Next button
  // ever calls nextClimb and the climber gets a dead swipe with no reason —
  // exactly the dead end that most needs explaining. So report the STATE here
  // rather than the action that cannot happen.
  //
  // Once per board, re-armed the moment forward navigation works again.
  //
  // Only when climbs were actually SKIPPED. Simply reaching the end of the
  // climber's own list is not a dead end worth a message: nothing vanished, and
  // a notice there would fire on every list end to explain a rule the climber
  // wrote themselves (issue #5403). "0 left" beside a disabled Next says it.
  const deadEndReportedBoardKeyRef = useRef<string | null>(null);
  const forwardSelection = useMemo(
    () =>
      selectNextQueueItemWithSuggestions(
        state.queue,
        state.currentClimbQueueItem,
        playlistSuggestionSource,
        toActiveBoardCompatibilityConfig(activeBoard),
        isReachableClimb,
      ),
    [state.queue, state.currentClimbQueueItem, playlistSuggestionSource, activeBoard, isReachableClimb],
  );
  useEffect(() => {
    const { item, skippedItems } = forwardSelection;
    if (item !== null || skippedItems.length === 0) {
      deadEndReportedBoardKeyRef.current = null;
      return;
    }
    if (deadEndReportedBoardKeyRef.current === activeBoardKey) return;
    deadEndReportedBoardKeyRef.current = activeBoardKey;
    // A swipe from here can add nothing to this; don't let it repeat the news.
    skipRunReportedForCurrentRef.current = true;
    trackClimbsSkippedOnBoard(skippedItems, null, 'queue_dead_end');
    showToast(
      tSettings('boardConfigMismatch.queueOffBoardToast', {
        count: skippedItems.length,
        name: skippedItems[0].climb.name,
      }),
      'info',
    );
  }, [forwardSelection, activeBoardKey, showToast, tSettings, trackClimbsSkippedOnBoard]);

  const nextClimb = useCallback(() => {
    const { queue, currentClimbQueueItem } = stateRef.current;
    const activeConfig = toActiveBoardCompatibilityConfig(activeBoardRef.current);
    const walkedSource = playlistSuggestionSourceRef.current;
    // Up next first, then the list (#6777): the same selection the drawer, the
    // rest timer and the workout runner make, so all of them land here.
    const {
      item: nextItem,
      skippedItems,
      trackResume,
    } = selectNextQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      walkedSource,
      activeConfig,
      isReachableClimbRef.current,
    );
    // Reported before the bail-out: a swipe that skipped everything and landed
    // nowhere is exactly when the climber most needs to know why. (The gesture
    // is normally disabled in that state — see the dead-end effect above — but
    // the Next button and the widget path can still land here.)
    reportClimbsSkippedOnBoardSwitch(skippedItems, nextItem);
    if (!nextItem) return;
    // Mirror web: a transient `playlist-peek:<uuid>` must never reach the WS
    // mutation (toQueueItemInput sends item.uuid verbatim). The laundering lives
    // in `resolveCommittableQueueItem` so the play drawer's commit button —
    // which can now pin a peek while browsing a shared session — applies exactly
    // the same rule. A converted peek was never in the queue, so it has to be
    // added; a real item is already there.
    const { item, converted } = resolveCommittableQueueItem(nextItem);
    storeTrackResume(walkedSource, trackResume);
    // New suggestions must match the server's insertion immediately after current.
    dispatchSetCurrent(item, converted, undefined, converted);
  }, [dispatchSetCurrent, reportClimbsSkippedOnBoardSwitch, storeTrackResume]);

  const previousClimb = useCallback(() => {
    const { queue, currentClimbQueueItem } = stateRef.current;
    // Mirrors nextClimb: on a list (issue #4829) backward navigation can land on
    // a playlist peek too — mint it into a real queue item before it reaches the
    // WS mutation. It retraces the walk (#6777): back through the Up next climbs
    // played, then onto the list climb they were played from.
    // The board only decides which queue entry stands for the list's previous
    // climb, so a climb from another layout between two of the list's climbs
    // can't make the swipe add a copy (#6664). Same inputs as nextClimb.
    const walkedSource = playlistSuggestionSourceRef.current;
    const { item: prevItem, trackResume } = selectPreviousQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      walkedSource,
      undefined,
      toActiveBoardCompatibilityConfig(activeBoardRef.current),
      isReachableClimbRef.current,
    );
    if (!prevItem) return;
    const { item, converted } = resolveCommittableQueueItem(prevItem);
    storeTrackResume(walkedSource, trackResume);
    // Match nextClimb and the server: suggestions insert immediately after current.
    dispatchSetCurrent(item, converted, undefined, converted);
  }, [dispatchSetCurrent, storeTrackResume]);

  // Select the absolute native target so a racing server echo cannot double-step.
  // iOS publishes natively; Android forwards the event for JS to publish.
  const dispatchWidgetNavigation = useCallback(
    (item: ClimbQueueItem, correlationId: string, options?: WidgetNavigationOptions) => {
      // The widget steps the queue by index. Where that is the step Next or
      // Previous would take on a list (into Up next, or back onto the list), the
      // track keeps its place the same way (#6777), so the player still knows
      // where the list picks up once the phone is back in hand.
      const { queue, currentClimbQueueItem } = stateRef.current;
      const walkedSource = playlistSuggestionSourceRef.current;
      if (walkedSource && currentClimbQueueItem) {
        const activeConfig = toActiveBoardCompatibilityConfig(activeBoardRef.current);
        const forward = selectNextQueueItemWithSuggestions(
          queue,
          currentClimbQueueItem,
          walkedSource,
          activeConfig,
          isReachableClimbRef.current,
        );
        const backward =
          forward.item?.uuid === item.uuid
            ? null
            : selectPreviousQueueItemWithSuggestions(
                queue,
                currentClimbQueueItem,
                walkedSource,
                undefined,
                activeConfig,
                isReachableClimbRef.current,
              );
        if (forward.item?.uuid === item.uuid) storeTrackResume(walkedSource, forward.trackResume);
        else if (backward?.item?.uuid === item.uuid) storeTrackResume(walkedSource, backward.trackResume);
      }
      if (options?.sendMutation) {
        dispatchSetCurrent(item, false, undefined, undefined, correlationId);
        return;
      }
      dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item, shouldAddToQueue: false, correlationId },
      });
    },
    [dispatchSetCurrent, storeTrackResume],
  );

  const mirrorRequestRef = useRef(false);
  /**
   * Resolves true only when the server accepted the orientation. A widget tap
   * replayed from the lock screen is retired on that answer, so a refused or
   * failed attempt has to be distinguishable from a successful one — a toast
   * alone would let an offline retry be thrown away.
   */
  const mirrorCurrentClimb = useCallback(
    async (mirrored: boolean, queueItemUuid: string) => {
      if (
        !sessionIdRef.current ||
        stateRef.current.currentClimbQueueItem?.uuid !== queueItemUuid ||
        mirrorRequestRef.current
      )
        return false;
      mirrorRequestRef.current = true;
      try {
        await mutations.mirrorCurrentClimb(mirrored, queueItemUuid);
        // Subscription confirmation normally arrives first; refresh also covers a lost echo.
        await resyncQueueFromServerRef.current();
        return true;
      } catch (error) {
        showQueueMutationErrorToast(error, t, showToast);
        return false;
      } finally {
        mirrorRequestRef.current = false;
      }
    },
    [mutations, showToast, t],
  );

  const dispatchWidgetMirror = useCallback(async (event: Extract<WidgetMirrorEvent, { kind: 'confirmed' }>) => {
    if (event.sessionId !== sessionIdRef.current) return false;
    const gate = queueSyncGateRef.current;
    if (!gate) return false;
    const reconcileReceipt = async () => {
      const reconciled = await resyncQueueFromServerRef.current();
      return reconciled && event.sessionId === sessionIdRef.current && (gate.getLastSequence() ?? -1) >= event.sequence;
    };
    // A receipt is a delta, not a full queue snapshot. On resume the gate can
    // be empty while native navigation is several events ahead of JS.
    if (gate.getLastSequence() === null) return reconcileReceipt();
    const envelope = { ...event, __typename: 'ClimbMirrored' as const };
    const decision = gate.evaluateIncoming(envelope);
    if (decision === 'ignore-stale') return true;
    if (decision === 'resync-gap') return reconcileReceipt();
    gate.noteApplied(envelope);
    dispatch({
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      serverSequence: event.sequence,
      payload: { mirroredUuid: event.queueItemUuid, mirrored: event.mirrored },
    });
    return true;
  }, []);

  // When the track the climber is currently walking was selected. Only the
  // dormancy event below reads it, to say how long the track stayed live (#5402).
  const suggestionSourceSelectedAtRef = useRef<number | null>(null);
  const setPlaylistSuggestionSource = useCallback(
    (source: PlaylistSuggestionSource | null) => {
      if (privacyRevocationGeneration !== getPrivacyRevocationGeneration()) return;
      suggestionSourceSelectedAtRef.current = source ? Date.now() : null;
      setPlaylistSuggestionSourceState(source);
    },
    [privacyRevocationGeneration],
  );

  // No-op unless the incoming source matches the active one (same playlist +
  // activated climb + board) — so a late async refresh can't clobber a newer
  // activation. Mirrors the reducer's REFRESH semantics. Says whether it took
  // the source, so a caller waiting on the refresh knows its track is the one
  // the climber walks (#6664).
  const refreshPlaylistSuggestionSource = useCallback(
    (source: PlaylistSuggestionSource): boolean => {
      const sameAccount = privacyRevocationGeneration === getPrivacyRevocationGeneration();
      // The refresh is built from the list, not from the walk: it keeps the
      // held track's place in Up next (#6777), or the list would forget where
      // to pick up while a queued climb plays.
      setPlaylistSuggestionSourceState((current) =>
        sameAccount && current && playlistSuggestionSourceMatches(current, source)
          ? withPlaylistTrackResume(source, current.resume ?? null)
          : current,
      );
      return sameAccount && playlistSuggestionSourceMatches(playlistSuggestionSourceRef.current, source);
    },
    [privacyRevocationGeneration],
  );

  // Moving off the list hands swipes back to the queue. While the current climb
  // is in `playlistSuggestionSource.climbs` (issue #4829), or a queued climb plays
  // Up next in the middle of the list (#6777, the track's `resume`), next/previous
  // walk Up next and then that ordered list. Plenty of things move the current climb
  // without going through `setCurrentClimb` — a crew member's CurrentClimbChanged,
  // a widget Next/Previous tap, or joining a session already parked on a climb.
  //
  // That guard used to live here as an effect, which left one render in which a
  // swipe walked the stale list. It now lives in
  // `resolveNavigationSuggestionSource` (@boardsesh/play-view), evaluated during
  // render at the point of use, so it holds for every writer at once and needs no
  // render window (issue #5403). The source is left in place; navigation simply
  // stops consulting it while it does not anchor the current climb.

  const publishPlaybackState = useCallback(
    (input: PublishPlaybackStateInput) => mutations.publishPlaybackState(input),
    [mutations],
  );
  // The crew rest clock's one write path (#5382): the publisher and the
  // auto-advance scheduler send through here, so the call joins the session first.
  const setSessionRestCadence = useCallback<QueueActionsContextValue['setSessionRestCadence']>(
    (input, options) => mutations.setSessionRestCadence(input, options),
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
      playNext,
      removeFromQueue,
      removeQueueItems,
      restoreQueueItems,
      reorderQueue,
      clearQueue,
      setQueue,
      getQueueSnapshot,
      appendQueueItems,
      setCurrentClimb,
      refreshAuthoredClimb,
      nextClimb,
      previousClimb,
      dispatchWidgetNavigation,
      mirrorCurrentClimb,
      dispatchWidgetMirror,
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
      subscribeToPlaybackEvents,
      publishPlaybackState,
      setSessionRestCadence,
    }),
    [
      addToQueue,
      playNext,
      removeFromQueue,
      removeQueueItems,
      restoreQueueItems,
      reorderQueue,
      clearQueue,
      setQueue,
      getQueueSnapshot,
      appendQueueItems,
      setCurrentClimb,
      refreshAuthoredClimb,
      nextClimb,
      previousClimb,
      dispatchWidgetNavigation,
      mirrorCurrentClimb,
      dispatchWidgetMirror,
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
      subscribeToPlaybackEvents,
      publishPlaybackState,
      setSessionRestCadence,
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

  // Queue-data selector: the queue array + current climb item, memoized on that
  // pair. The reducer spreads state on every update, so these two references
  // survive session/wall-lit/roster bookkeeping — the play drawer and queue
  // sheets subscribe here and stop re-rendering on that unrelated churn.
  const queueDataValue = useMemo<QueueDataContextValue>(
    () => ({ queue: state.queue, currentClimbQueueItem: state.currentClimbQueueItem }),
    [state.queue, state.currentClimbQueueItem],
  );

  // SessionId-only selector: identity changes only when a session starts/ends,
  // so structural readers (tab layout, board adapter, session screen) stop
  // re-rendering the navigation tree on every queue mutation.
  const sessionIdValue = useMemo<QueueSessionIdContextValue>(() => ({ sessionId, undoScope }), [sessionId, undoScope]);

  // Live analytics + presence: the ≤1/2s party push recreates only this small
  // value, re-rendering only SessionScreen + InSessionView.
  const liveStatsValue = useMemo<QueueLiveStatsContextValue>(
    () => ({ liveStats, sessionUsers }),
    [liveStats, sessionUsers],
  );

  // "Is anyone else here" — the gate that turns swipes and list taps into
  // browsing instead of wall control. Derived here rather than in the drawer and
  // the climb list so those two hot surfaces subscribe to a boolean that flips
  // only across the solo ↔ crew boundary: the ≤1/2s stats push and every
  // presence delta recreate `sessionUsers`, and re-rendering board art or a
  // virtualized list twice a second for an answer that didn't change is exactly
  // the provider-value churn the perf checklist bans.
  //
  // Counts PEERS (excluding this client's own entries), not roster participants
  // — see `countSessionPeers` for why the participant count turned lone climbers
  // into crews, and why connected and reconnecting peers are kept apart.
  const sharedBrowseEnabled = useSharedSessionBrowseEnabled();
  const sessionActive = sessionId != null;
  const { connected: connectedPeerCount, reconnecting: reconnectingPeerCount } = countSessionPeers(sessionUsers, {
    // `participantId` IS the signed-in user's uuid for an authenticated
    // client and the connection id for an anonymous one — either way it is
    // the key this client's own roster entry carries, which is all the
    // self-exclusion needs.
    participantId: sessionRuntimeState.participantId,
  });
  // Arms the gate: someone else is here with a live socket.
  const crewPresentNow = shouldDefaultToBrowse({ sessionActive, connectedPeerCount });
  // Holds the gate: someone else is here, live or inside the server's reconnect
  // grace window. A peer whose wifi flapped has not left — their seat and their
  // wall stakes are still on the roster — so the gate must not hand the wall
  // back for the seconds their socket is down. This never ARMS anything: a
  // reconnecting-only roster (a lone climber's own dying connection) reads as no
  // crew, which is what keeps the lone climber's board theirs.
  const crewHoldingNow = sessionActive && connectedPeerCount + reconnectingPeerCount > 0;
  // Hold a newly-arrived crew for a dwell before acting on it, and drop it the
  // instant it is gone. The asymmetry is deliberate. Arming late costs a climber a
  // couple of seconds of ordinary wall control while a peer settles; arming on a
  // one-frame roster blip costs them the wall until they find a button they have
  // no reason to look for. Releasing is immediate for the same reason — being
  // left alone must give the board straight back.
  const [crewDwellElapsed, setCrewDwellElapsed] = useState(false);
  useEffect(() => {
    if (!crewHoldingNow) {
      setCrewDwellElapsed(false);
      return;
    }
    // Live peer: start (or restart) the arming dwell. Reconnecting-only: neither
    // arm nor release — whatever the gate was, it stays, until the peer is back
    // (this effect re-runs with a live peer) or evicted (`crewHoldingNow` drops).
    if (!crewPresentNow) return;
    const timer = setTimeout(() => setCrewDwellElapsed(true), SHARED_SESSION_DWELL_MS);
    return () => clearTimeout(timer);
  }, [crewPresentNow, crewHoldingNow]);
  // The crew itself, flag or no flag: who may move the wall must not depend on a
  // gesture rollout (see `isCrewSession` on the context).
  const isCrewSession = crewHoldingNow && crewDwellElapsed;
  const isSharedSession = sharedBrowseEnabled && isCrewSession;
  const sharedSessionValue = useMemo<QueueSharedSessionContextValue>(
    () => ({ isSharedSession, isCrewSession }),
    [isSharedSession, isCrewSession],
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
          <QueueSharedSessionContext.Provider value={sharedSessionValue}>
            <QueueActionsContext.Provider value={actionsValue}>
              <QueuePlaylistSuggestionContext.Provider value={playlistSuggestionValue}>
                <QueueActiveClimbContext.Provider value={activeClimbValue}>
                  <QueueHasActiveClimbContext.Provider value={hasActiveClimbValue}>
                    <QueueDataContext.Provider value={queueDataValue}>
                      <QueueContext.Provider value={contextValue}>{children}</QueueContext.Provider>
                    </QueueDataContext.Provider>
                  </QueueHasActiveClimbContext.Provider>
                </QueueActiveClimbContext.Provider>
              </QueuePlaylistSuggestionContext.Provider>
            </QueueActionsContext.Provider>
          </QueueSharedSessionContext.Provider>
        </QueueLiveStatsContext.Provider>
      </QueueSessionIdContext.Provider>
    </QueueSessionControlContext.Provider>
  );
}
