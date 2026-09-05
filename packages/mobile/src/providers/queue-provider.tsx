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
  decideAdd,
  deriveAcceptedConfigs,
} from '@boardsesh/queue';
import type {
  QueueSearchParams,
  ClimbQueueItem,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
} from '@boardsesh/queue';
import {
  countDistinctSessionUsers,
  countConnectedSessionPeers,
  createJoinSessionTracker,
  type QueueSyncGate,
} from '@boardsesh/queue-runtime';
import { useQueueMutations, type PublishPlaybackStateInput } from '@boardsesh/queue-react';
import type { QueueItemAttribution } from '@boardsesh/queue-react/queue-item-input';
import type { PlaybackStateChangedEvent, SessionUser } from '@boardsesh/shared-schema';
import { execute, isRateLimitedError } from '@boardsesh/graphql-client';
import { buildBoardPath, classifyClimbBoardCompatibility, toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS, buildBoardRenderTelemetryProps } from '@boardsesh/analytics';
import { JOIN_SESSION, UPDATE_USERNAME } from '@boardsesh/graphql/operations/queue-session';
import { getWsClient } from '../lib/graphql/ws-client';
import { getHttpClient } from '../lib/graphql/client';
import {
  GET_SESSION_QUEUE_STATE,
  type SessionLiveStatsEvent,
  type GetSessionQueueStateQueryResponse,
} from '../lib/graphql/operations';
import { getStoredActiveBoard } from '../lib/active-board-store';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import { findPreviousQueueItem, findNextQueueItemWithSuggestions, shouldDefaultToBrowse } from '@boardsesh/play-view';
import { useSharedSessionBrowseEnabled } from './feature-flags-provider';
import { toClimbQueueItem } from '../lib/queue-conversion';
import { resolveCommittableQueueItem, toQueueItemWireInput, isClimbResolved } from '../lib/climb-to-queue-item';
import { track, registerRenderSuperProperties } from '../lib/analytics';
import { markClimbAction, markClimbViewed } from '../lib/climb-view-session';
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
} from './queue/queue-contexts';
import { useCrossBoardAddGate } from './queue/use-cross-board-add-gate';
import { useQueueRegrade } from './queue/use-queue-regrade';
import { useQueueResolveClimbs } from './queue/use-queue-resolve-climbs';
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
  useActiveClimbUuid,
  useHasActiveClimb,
  useQueueData,
  useQueueActions,
  usePlaylistSuggestionSource,
} from './queue/queue-contexts';
export type { StartSessionConfig } from './queue/queue-contexts';

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
  // Single-flight guard for resyncQueueFromServer: a failed mutation in a party
  // session refetches the authoritative queue, but several deltas can fail in a
  // burst (e.g. clearQueue removes N items, the WS is down). Coalesce them into
  // one in-flight fetch so we don't hammer the server or thrash the reducer.
  const resyncInFlightRef = useRef(false);
  // Coalesce-then-rerun-once companion to the single-flight guard above: a
  // resync requested while a fetch is already in flight may reflect a
  // mutation the in-flight snapshot predates (e.g. the trailing removals of a
  // clearQueue burst). Dropping it outright would apply the older snapshot,
  // re-baseline the gate to it, and leave the watchdog blind (local hash ==
  // tracked snapshot hash) — so remember the request and run exactly one more
  // fetch after the current one settles.
  const resyncPendingRef = useRef(false);
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

  // The signed-in user's display name + avatar (undefined while signed out or
  // still loading). Sent with JOIN_SESSION so the backend roster shows real
  // identity instead of a `User-<uuid>` fallback + empty avatar. Mirrored into a
  // ref because the joinTracker is memoized once (empty deps) and its execute
  // closure must read the latest value — mirrors web's usernameRef/avatarUrlRef
  // in persistent-session/hooks/session-connection-ports.ts.
  const { profile: partyProfile, username: partyUsername, avatarUrl: partyAvatarUrl } = usePartyProfile();
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
  // while signed out / before the party profile resolves. Assigned during render
  // (same pattern as identityRef) so the queue callbacks — memoized on
  // `mutations`, not on identity — always read the latest.
  //
  // Requires BOTH a profile id and a non-empty username: an anonymous phone must
  // not push a blank-named avatar onto every peer's queue row.
  //
  // Assigned during render, so there is a window between a session join landing
  // a new `clientId` and the next render where a stamp would carry
  // `addedBy: null` with `addedByUser` populated. Peers render the avatar off
  // `addedByUser`, so the row still shows the right person; only the legacy
  // clientId field is absent. Same trade the other during-render refs here make.
  const selfAttributionRef = useRef<QueueItemAttribution | null>(null);
  selfAttributionRef.current =
    partyProfile?.id && partyUsername
      ? {
          addedBy: sessionRuntimeStateRef.current.clientId || null,
          addedByUser: { id: partyProfile.id, username: partyUsername, avatarUrl: partyAvatarUrl ?? null },
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
      // Firing a `Climb View Opened` in either window labels the view with the
      // wrong `render_mode`, and a mislabelled view is worse than a late one:
      // it lands in the other arm of the A/B this whole event exists to
      // measure. So the view waits — see the markClimbViewed effect below.
      renderSettingsPending:
        !boardRenderSettingsLoaded ||
        (rendererSupport === null && requestedBoardRenderMode(boardRenderSettings) === 'aura'),
    };
  }, [boardRenderSettings, boardRenderSettingsLoaded, boardseshSupportTick]);
  // Mirrored into refs for the same reason activeBoardRef is: callbacks below
  // read the CURRENT resolved settings without needing to be rebuilt every
  // time they change.
  const effectiveRenderSettingsRef = useRef(effectiveRenderSettings);
  effectiveRenderSettingsRef.current = effectiveRenderSettings;
  const renderSettingsPendingRef = useRef(renderSettingsPending);
  renderSettingsPendingRef.current = renderSettingsPending;
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

  // Must run before the view-firing effect below: PostHog's in-memory
  // `register` is synchronous, so by the time that effect's `markClimbViewed`
  // call reaches PostHog, these super properties are already registered on it.
  useEffect(() => {
    registerRenderSuperProperties(effectiveRenderSettings);
  }, [effectiveRenderSettings]);

  /**
   * Fire `Climb View Opened` for a climb that is now drawn on the board.
   *
   * Stable identity (everything it needs is read from a ref), so it can be
   * handed to the play drawer through the actions context without churning it.
   * A no-op while `renderSettingsPending`, and a no-op with no active board —
   * an event with no `board_name` cannot be stratified, and the stratification
   * rule (docs/board-render-analytics.md) says never pool across boards.
   */
  const noteClimbViewed = useCallback((climbUuid: string) => {
    if (renderSettingsPendingRef.current) return;
    const activeBoard = activeBoardRef.current;
    const activeBoardName = activeBoard ? toBoardName(activeBoard.boardType) : null;
    if (!activeBoard || !activeBoardName) return;
    markClimbViewed(
      climbUuid,
      buildBoardRenderTelemetryProps(effectiveRenderSettingsRef.current, {
        boardName: activeBoardName,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
      }),
    );
  }, []);

  // A view is the CLIMB CHANGING, not the call that changed it. Keying off
  // `setCurrentClimb` (the first cut of this) missed most of them: `nextClimb`
  // and `previousClimb` dispatch to the reducer directly, so every swipe
  // through the queue — the single most common way a climber moves between
  // climbs — fired nothing, and the A/B would have been measured almost
  // entirely on taps.
  //
  // Keyed on the current queue item's uuid AND its climb uuid, because either
  // one changing means a different climb is drawn: re-tapping the current
  // climb mints a fresh queue-item uuid (a deliberate fresh pass), while a peer
  // replacing the slot's contents changes the climb uuid under a stable item
  // uuid. Neither key changes when a thin peer item merely hydrates, so
  // hydration doesn't double-count.
  //
  // Peer-originated changes count too, on purpose: a party member advancing the
  // queue puts a climb on THIS climber's board, and it is that drawn climb the
  // A/B is measuring. Same for a hydrated queue on app open — the restored
  // climb is what they see when the drawer comes up.
  const currentQueueItemUuid = state.currentClimbQueueItem?.uuid ?? null;
  const currentClimbUuid = state.currentClimbQueueItem?.climb.uuid ?? null;
  useEffect(() => {
    if (!currentQueueItemUuid || !currentClimbUuid) return;
    // Still resolving which drawing this climber is on. `renderSettingsPending`
    // is a dep, so this effect re-runs (and fires, once) the moment the settings
    // load or the capability probe answers — the view is deferred, not dropped.
    if (renderSettingsPending) return;
    noteClimbViewed(currentClimbUuid);
  }, [currentQueueItemUuid, currentClimbUuid, renderSettingsPending, noteClimbViewed]);

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
          return buildBoardPath(
            activeBoard.boardType,
            activeBoard.layoutId,
            activeBoard.sizeId,
            activeBoard.setIds,
            activeBoard.angle,
          );
        },
        execute: async ({ sessionId: sid, boardPath }) => {
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
          }>(getWsClient(), {
            query: JOIN_SESSION,
            variables: {
              sessionId: sid,
              boardPath,
              username: sentIdentity.username,
              avatarUrl: sentIdentity.avatarUrl,
            },
          });
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
    void execute(getWsClient(), { query: UPDATE_USERNAME, variables: pending })
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
    sessionIdRef.current = sessionId;
    // Backstop clear on any session change — start, join, leave, or a direct A→B
    // switch (#3868). The primary guard is the re-broadcast effect's synchronous
    // deferred.sessionId vs sessionIdRef.current check (PR #3894 Codex thread 3);
    // this passive-effect clear can't fire before an already-pending re-broadcast
    // effect flushes, so it's defence-in-depth, not the race fix.
    pendingUnsyncedCurrentRef.current = null;
  }, [sessionId]);

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
    dispatch,
    sessionIdRef,
    setSessionId,
    stateRef,
    sessionId,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    playlistSuggestionSource,
    setPlaylistSuggestionSourceState,
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
    dispatch,
    setPlaylistSuggestionSourceState,
    resyncInFlightRef,
    resyncPendingRef,
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
  const resyncQueueFromServer = useCallback(async (): Promise<boolean> => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return false;
    if (resyncInFlightRef.current) {
      // Coalesce-then-rerun-once: this request may reflect a mutation the
      // in-flight fetch's snapshot predates (see resyncPendingRef). The
      // `finally` below runs exactly one trailing fetch for the whole burst.
      resyncPendingRef.current = true;
      return false;
    }
    resyncInFlightRef.current = true;

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
      resyncPendingRef.current = false;
      restartJoinedSubscriptionsRef.current?.();
    };

    try {
      const response = await getHttpClient().request<GetSessionQueueStateQueryResponse>(GET_SESSION_QUEUE_STATE, {
        sessionId: activeSessionId,
      });
      // The session may have ended (or we switched sessions) while the fetch was
      // in flight — only apply when it's still the active one.
      if (sessionIdRef.current !== activeSessionId) return false;
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
      pendingUnsyncedCurrentRef.current = null;
      dispatch({
        type: 'INITIAL_QUEUE_DATA',
        payload: {
          queue: queueState.queue.map(toClimbQueueItem),
          currentClimbQueueItem: queueState.currentClimbQueueItem
            ? toClimbQueueItem(queueState.currentClimbQueueItem)
            : null,
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
      if (__DEV__) console.warn('[queue] resyncQueueFromServer failed', error);
      reportHandledError(error, { tags: { source: 'queue-sync', op: 'resync' } });
      // Same membership rationale as the null-queueState branch — an errored
      // query can't reconcile anything, but a resubscribe's FullSync can.
      // Skip when the session changed mid-flight (the new session effect owns
      // its own subscriptions).
      if (sessionIdRef.current === activeSessionId) {
        fallbackToSubscriptionRestart();
      }
      return false;
    } finally {
      resyncInFlightRef.current = false;
      // Trailing rerun for requests coalesced during this fetch (exactly one
      // — the rerun clears the flag before fetching, and anything that lands
      // during the rerun re-queues behind it the same way).
      if (resyncPendingRef.current) {
        resyncPendingRef.current = false;
        void resyncQueueFromServerRef.current();
      }
    }
  }, []);
  const resyncQueueFromServerRef = useRef(resyncQueueFromServer);
  resyncQueueFromServerRef.current = resyncQueueFromServer;

  // Active-session realtime engine: join retry/backoff, queue + session
  // subscriptions, sync-gate wiring, roster/liveStats/wall-lit updates, peer
  // angle-follow, and the 60s hash watchdog. See useSessionRealtime.
  useSessionRealtime({
    authTransportRevision,
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
  // re-send fails. `reorderQueue` never reaches this path at all — it rolls
  // back locally instead.
  const resyncQueueAfterMutationFailure = useCallback(async () => {
    if (!sessionIdRef.current) return;
    const refreshed = await resyncQueueFromServerRef.current();
    if (refreshed) showToast(t('mobile.queue.outOfSyncRefreshed'), 'error');
  }, [showToast, t]);

  // Failure handler for the four queue-CONTENT mutations (add/remove/clear/setQueue).
  // A throttled one shows TWO toasts by design (#3929): the pacing hint now, and
  // `outOfSyncRefreshed` a round-trip later once reconciliation replaced the queue —
  // same contract as setCurrentClimb ("Two toasts, deliberately" in the tests).
  // Not showQueueMutationErrorToast: that also fires `actionFailed` on every
  // non-throttle error, and these syncs must stay silent when offline (#2763).
  const reconcileFailedContentMutation = useCallback(
    (error: unknown) => {
      if (sessionIdRef.current && isRateLimitedError(error)) showToast(t('mobile.queue.rateLimited'), 'error');
      void resyncQueueAfterMutationFailure();
    },
    [resyncQueueAfterMutationFailure, showToast, t],
  );

  const confirmClimbOnWall = useCallback((climbUuid: string) => mutations.confirmClimbOnWall(climbUuid), [mutations]);
  const setSessionBoardSerial = useCallback((serial: string) => mutations.setSessionBoardSerial(serial), [mutations]);
  // Broadcast that THIS phone's BLE link to the wall dropped. The shared mutation
  // swallows transport errors and is a true no-op in solo (never creates a
  // session), so the BLE provider can fire it on every drop. Locally, our own
  // WallDisconnected echo flips the lightbulb off through the subscription
  // handler — no need to set isSessionWallLit here.
  const reportWallDisconnect = useCallback(() => mutations.reportWallDisconnect(), [mutations]);

  // Self-healing re-grade: refetch angle-specific grades for queued climbs and
  // the displayed playlist peek whenever the active angle drifts. See useQueueRegrade.
  useQueueRegrade({
    activeBoard,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    playlistSuggestionSourceRef,
    playlistSuggestionSource,
    dispatch,
    setPlaylistSuggestionSourceState,
  });

  // Self-healing resolve: a partially-synced peer item (or a snapshot restored
  // before its climb data loaded) can land in the queue with an unresolved climb.
  // Re-fetch it by uuid at the live angle and patch it in place so the row shows
  // the real name/grade/thumbnail instead of an "Unknown Climb" placeholder. See
  // useQueueResolveClimbs (#2527).
  useQueueResolveClimbs({ activeBoard, queue: state.queue, dispatch });

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
    (rawItem: ClimbQueueItem) => {
      // Whoever tapped "add" owns this climb — stamp identity before the dispatch
      // so the local queue and the broadcast carry the same object (#3995).
      const item = attributeNewItem(rawItem);
      // Optimistic local dispatch is the source of truth for the user's queue.
      // The server echoes this item via the WS subscription, but
      // DELTA_ADD_QUEUE_ITEM dedupes by uuid so the echo is a no-op. The shared
      // mutation only SYNCs the add to an existing session (solo is local-only —
      // it never creates one). That sync is best-effort: a solo user with no
      // session, an offline phone, or a transient WS error must NOT see "Action
      // failed" when the local queue is already correct. Dev-log only.
      dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item } });
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
      });
      // Board-render A/B telemetry (issue #2202): a no-op unless this climb has
      // an open view from markClimbViewed (setCurrentClimb) — e.g. a queue add
      // straight from search never opened one, and correctly fires nothing.
      markClimbAction(item.climb.uuid, 'queue');
      // No unresolved-climb guard here: addToQueue is only ever called with a
      // fully-resolved climb from search / detail / playlist (a real user tap),
      // never a peer placeholder. The re-broadcast vectors that need guarding are
      // setCurrentClimb (next/previousClimb can land on an unhydrated peer item)
      // and setQueue (whole-queue replace) — see #2527.
      mutations.addQueueItem(item).catch((error) => {
        if (__DEV__) console.warn('[queue] addQueueItem sync failed', error);
        // In a party session the add never reached peers — reconcile against the
        // server so this client doesn't silently diverge. Solo is a true no-op.
        reconcileFailedContentMutation(error);
      });
      // Surface the "Climb added to queue · Open" snackbar for every add path.
      showQueueAddedSnackbar();
    },
    [attributeNewItem, mutations, reconcileFailedContentMutation, showQueueAddedSnackbar],
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
    async (rawItem: ClimbQueueItem): Promise<'added' | 'cancelled'> => {
      const activeBoard = activeBoardRef.current;
      const activeBoardName = activeBoard ? toBoardName(activeBoard.boardType) : null;
      const activeConfig =
        activeBoardName && activeBoard ? { boardName: activeBoardName, layoutId: activeBoard.layoutId } : undefined;
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
        classify: classifyClimbBoardCompatibility,
      });

      if (decision.kind === 'confirm') {
        const result = await requestCrossBoardAdd({
          climbConfigKey: decision.climbConfigKey,
          climbBoardName: decision.climbBoardName,
          climbLayoutId: decision.climbLayoutId,
          activeBoardName: activeBoard?.boardType,
        });
        if (result.outcome === 'cancel') return 'cancelled';
        if (result.outcome === 'switch') {
          // The queue followed them onto the new board, so peers must too — a
          // local-only switch would leave the session's board path (and every
          // peer's wall) pointing at the board we just left.
          const { boardType, layoutId, sizeId, setIds, angle } = result.board;
          // The shared mutation swallows its own transport errors into
          // `onBestEffortError` (which reports them), so what lands here is the
          // rarer pre-send failure — ensureJoined rejecting. Report that too
          // rather than dropping it, or a party that silently never followed
          // the switch leaves no trace at all.
          void setSessionBoardPath(buildBoardPath(boardType, layoutId, sizeId, setIds, angle)).catch((error) => {
            if (__DEV__) console.warn('[queue] setSessionBoardPath after board switch failed', error);
            reportHandledError(error, { tags: { source: 'queue-sync', op: 'set-board-path-switch' } });
          });
        }
      }

      commitQueueAdd(rawItem);
      return 'added';
    },
    [commitQueueAdd, requestCrossBoardAdd, setSessionBoardPath],
  );

  const removeFromQueue = useCallback(
    (uuid: string) => {
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
        if (__DEV__) console.warn('[queue] removeQueueItem sync failed', error);
        // The remove never reached peers in a party session — reconcile so the
        // dropped item doesn't linger on peers (or come back here). Solo no-ops.
        reconcileFailedContentMutation(error);
      });
    },
    [mutations, reconcileFailedContentMutation],
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
    // A whole-queue clear supersedes any deferred current re-broadcast (#3868).
    pendingUnsyncedCurrentRef.current = null;
    dispatch({ type: 'CLEAR_QUEUE' });
    track(SHARED_EVENTS.QueueCleared, { layoutId: activeBoardRef.current?.layoutId, totalCount: itemsToRemove.length });
    setPlaylistSuggestionSourceState(null);
    // If any per-item remove fails in a party session, the cleared items may
    // still live on peers — reconcile once against the server (single-flight
    // coalesces the burst) and tell the user we refreshed. Solo: the local
    // clear is authoritative, so resync no-ops and no toast fires.
    void Promise.allSettled(itemsToRemove.map((item) => mutations.removeQueueItem(item.uuid))).then((results) => {
      const rejectedRemovals = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejectedRemovals.length === 0) return;
      // A clear fires N per-item removes and the limiter typically rejects only
      // the tail, so prefer a throttled reason over the first one — otherwise an
      // unrelated early failure would swallow the pacing hint.
      const throttledRemoval = rejectedRemovals.find((rejected) => isRateLimitedError(rejected.reason));
      reconcileFailedContentMutation((throttledRemoval ?? rejectedRemovals[0]).reason);
    });
  }, [mutations, reconcileFailedContentMutation]);

  // Replace the whole queue in one shot: optimistic local UPDATE_QUEUE (the
  // source of truth for the user's queue) + SET_QUEUE sync that no-ops in solo
  // and broadcasts to party peers when a session exists. In party mode a sync
  // failure would leave peers on the old queue, so reconcile like other failed
  // session mutations.
  const setQueue = useCallback(
    (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => {
      // A whole-queue replace sets its own current; it supersedes any deferred
      // current re-broadcast (#3868).
      pendingUnsyncedCurrentRef.current = null;
      // Stamp BEFORE the dispatch, and feed the same array to both the local
      // reducer and the broadcast — otherwise this device's own queue would show
      // no author while peers saw one (#3995). The membership check reads
      // `stateRef.current.queue`, which is still the pre-dispatch queue here, so
      // a climb the crew already had keeps whoever queued it.
      const existingUuids = new Set(stateRef.current.queue.map((queueItem) => queueItem.uuid));
      const attributedQueue = queue.map((item) => attributeNewItem(item, existingUuids));
      const attributedCurrent = currentClimbQueueItem
        ? (attributedQueue.find((item) => item.uuid === currentClimbQueueItem.uuid) ??
          attributeNewItem(currentClimbQueueItem, existingUuids))
        : currentClimbQueueItem;
      dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: attributedQueue, currentClimbQueueItem: attributedCurrent ?? null },
      });
      // Keep the full queue locally, but never broadcast a placeholder/thin item
      // to peers (#2527): drop unresolved items from the wire payload (they can't
      // form a valid ClimbInput and peers can't render them). useQueueResolveClimbs
      // hydrates any resolvable item in place; a later mutation re-syncs the real
      // one. An unresolved current climb is likewise not sent as current.
      const syncableQueue = attributedQueue.filter((item) => isClimbResolved(item.climb));
      const syncableCurrent =
        attributedCurrent && isClimbResolved(attributedCurrent.climb) ? attributedCurrent : undefined;
      mutations.setQueue(syncableQueue, syncableCurrent).catch((error) => {
        if (__DEV__) console.warn('[queue] setQueue sync failed', error);
        reconcileFailedContentMutation(error);
      });
    },
    [attributeNewItem, mutations, reconcileFailedContentMutation],
  );

  // Stable live read of the queue + current climb (see QueueContextValue). Reads
  // stateRef so callers get the latest without subscribing to state re-renders.
  const getQueueSnapshot = useCallback(
    () => ({ queue: stateRef.current.queue, currentClimbQueueItem: stateRef.current.currentClimbQueueItem }),
    [],
  );

  // Queue a generated session behind whatever the climber already has going,
  // instead of replacing it. Leaving the current pointer alone is what keeps the
  // BLE auto-sender (it writes state.currentClimbQueueItem) from repainting the
  // wall out from under someone mid-project, and appending rather than replacing
  // keeps their hand-queued climbs. Only when nothing is current do we open on
  // the session's first climb. Mirrors web's start-sesh-drawer.
  const appendGeneratedSession = useCallback(
    (items: ClimbQueueItem[]) => {
      // Nothing generated: don't broadcast a SET_QUEUE that changes nothing.
      if (items.length === 0) return;
      const { queue, currentClimbQueueItem } = stateRef.current;
      setQueue([...queue, ...items], currentClimbQueueItem ?? items[0]);
    },
    [setQueue],
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
    async (item: ClimbQueueItem, activationSessionId: string | null) => {
      // Capture the session this slot belongs to. Every leg below runs after an
      // await, and the undo leg in particular can wake up in a DIFFERENT session
      // (the climber ended this one and joined another while the add was backing
      // off) — a remove aimed at that session is aimed at the wrong crew's queue.
      // Same discipline the coalescer applies to its own deferred sends.
      const recoverySessionId = sessionIdRef.current;
      if (!recoverySessionId) return;
      // The activation was issued into a different room than the one we're in
      // now: the throttled setCurrentClimb sat in back-off while the climber
      // left and joined elsewhere. Re-sending here would append the OLD room's
      // climb to the NEW crew's queue. `activationSessionId` is snapshotted by
      // dispatchSetCurrent at issue time — the live ref is useless for this,
      // because it is read fresh on entry and so always agrees with itself.
      if (recoverySessionId !== activationSessionId) return;
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
        void resyncQueueAfterMutationFailure();
        return;
      }
      // The add can sit in `execute`'s rate-limit back-off for seconds. If the
      // climber dropped the climb inside that window their remove raced ahead
      // of this add, so the slot we just landed is back on the whole crew's
      // queue. The local queue is the record of intent — undo it rather than
      // leave a climb nobody asked for. Only while we're still in the session
      // the add went to: after a session swap the local queue describes the new
      // room, and its lack of this item says nothing about the old one.
      if (sessionIdRef.current !== recoverySessionId) return;
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
        void resyncQueueAfterMutationFailure();
      });
    },
    [mutations, resyncQueueAfterMutationFailure],
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
    ) => {
      // Activating a climb that isn't in the queue yet (shouldAddToQueue, or the
      // playlist peek minted in nextClimb) introduces it — stamp it before the
      // dispatch so state and broadcast agree. Navigating onto an item already in
      // the queue is a no-op here: attributeNewItem sees the uuid and leaves it
      // alone, so stepping through the crew's queue never re-authors it (#3995).
      const item = attributeNewItem(rawItem);
      const correlationId = coordinator.generateCorrelationId();
      dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        // playlistSuggestionSource is client-only state — when present the
        // reducer sets it + prunes suggested-after-current; when undefined it's
        // left unchanged. It is intentionally NOT sent to the server mutation.
        // insertAfterCurrent keeps the optimistic queue in step with the server
        // (issue #2217): a newly activated climb slots in right after the
        // current climb, not at the end.
        payload: {
          item,
          shouldAddToQueue,
          isServerEvent: false,
          correlationId,
          playlistSuggestionSource,
          insertAfterCurrent,
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
      if (!isClimbResolved(item.climb)) {
        if (__DEV__) console.warn('[queue] skipping setCurrentClimb sync for an unresolved climb. See #2527.');
        pendingUnsyncedCurrentRef.current = { queueItemUuid: item.uuid, sessionId: sessionIdRef.current };
        return;
      }
      // A real broadcast supersedes any deferred one — drop it so a late hydrate
      // of the previously-skipped slot can't re-broadcast an item we've moved off.
      pendingUnsyncedCurrentRef.current = null;
      coordinator.trackPendingMutation(correlationId);
      // The room this activation is aimed at. A throttled setCurrentClimb can
      // sit in back-off long enough for the climber to leave and join another
      // session, so the recovery below needs the id from HERE — by the time it
      // runs, the live ref may already point at the new room (#4009).
      const activationSessionId = sessionIdRef.current;
      mutations.setCurrentClimb(item, shouldAddToQueue, correlationId).catch((error: unknown) => {
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
          void resyncQueueAfterMutationFailure();
          return;
        }
        // Throttled while ALSO adding a fresh climb to the queue: the pointer
        // half self-heals, the new slot doesn't. Re-send it on its own so the
        // content change isn't stranded locally (solo no-ops — its queue is
        // authoritative and there's no server to fall behind).
        if (throttled && shouldAddToQueue) {
          void recoverThrottledQueueAdd(item, activationSessionId);
        }
        // Solo (no server to reconcile) and the rate-limited party case both
        // land here: toast only, no resync.
        showQueueMutationErrorToast(error, t, showToast);
      });
    },
    [attributeNewItem, coordinator, mutations, recoverThrottledQueueAdd, resyncQueueAfterMutationFailure, showToast, t],
  );

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
  useEffect(() => {
    const pending = pendingUnsyncedCurrentRef.current;
    if (!pending) return;
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
  }, [state.currentClimbQueueItem, dispatchSetCurrent]);

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
      // Board-render A/B telemetry (issue #2202) is NOT fired here: the
      // `Climb View Opened` effect above keys off the current climb changing,
      // which covers this dispatch as well as the swipe paths that never come
      // through here at all.
      //
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
    // Mirror web: a transient `playlist-peek:<uuid>` must never reach the WS
    // mutation (toQueueItemInput sends item.uuid verbatim). The laundering lives
    // in `resolveCommittableQueueItem` so the play drawer's commit button —
    // which can now pin a peek while browsing a shared session — applies exactly
    // the same rule. A converted peek was never in the queue, so it has to be
    // added; a real item is already there.
    const { item, converted } = resolveCommittableQueueItem(nextItem);
    dispatchSetCurrent(item, converted);
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
      getQueueSnapshot,
      appendGeneratedSession,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      noteClimbViewed,
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
      subscribeToPlaybackEvents,
      publishPlaybackState,
    }),
    [
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      setQueue,
      getQueueSnapshot,
      appendGeneratedSession,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      noteClimbViewed,
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
      subscribeToPlaybackEvents,
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
  const sessionIdValue = useMemo<QueueSessionIdContextValue>(() => ({ sessionId }), [sessionId]);

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
  // Counts connected PEERS (excluding this client's own entries), not roster
  // participants — see `countConnectedSessionPeers` for why the participant
  // count turned lone climbers into crews.
  const sharedBrowseEnabled = useSharedSessionBrowseEnabled();
  const crewPresentNow = shouldDefaultToBrowse({
    sessionActive: sessionId != null,
    connectedPeerCount: countConnectedSessionPeers(sessionUsers, {
      // `participantId` IS the signed-in user's uuid for an authenticated
      // client and the connection id for an anonymous one — either way it is
      // the key this client's own roster entry carries, which is all the
      // self-exclusion needs.
      participantId: sessionRuntimeState.participantId,
    }),
  });
  // Hold a newly-arrived crew for a dwell before acting on it, and drop it the
  // instant it goes. The asymmetry is deliberate. Arming late costs a climber a
  // couple of seconds of ordinary wall control while a peer settles; arming on a
  // one-frame roster blip costs them the wall until they find a button they have
  // no reason to look for. Releasing is immediate for the same reason — being
  // left alone must give the board straight back.
  const [crewDwellElapsed, setCrewDwellElapsed] = useState(false);
  useEffect(() => {
    if (!crewPresentNow) {
      setCrewDwellElapsed(false);
      return;
    }
    const timer = setTimeout(() => setCrewDwellElapsed(true), SHARED_SESSION_DWELL_MS);
    return () => clearTimeout(timer);
  }, [crewPresentNow]);
  const isSharedSession = sharedBrowseEnabled && crewPresentNow && crewDwellElapsed;
  const sharedSessionValue = useMemo<QueueSharedSessionContextValue>(() => ({ isSharedSession }), [isSharedSession]);

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
