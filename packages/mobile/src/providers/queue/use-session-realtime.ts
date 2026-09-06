import { useContext, useEffect } from 'react';
import { AppState } from 'react-native';
import { QueryClientContext } from '@tanstack/react-query';
import { computeQueueStateHash, computeQueueStateHashOrdered } from '@boardsesh/queue';
import type { ClimbQueueItem, QueueAction, QueueState } from '@boardsesh/queue';
import {
  applySessionRuntimeEvent,
  createQueueSyncGate,
  mapSubscriptionEnvelopeToAction,
  RESYNC_LOOP_THRESHOLD,
  type QueueSyncGate,
  type QueueSyncGateEvent,
  type RuntimeSessionState,
  type SubscriptionWireEnvelope,
} from '@boardsesh/queue-runtime';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import type { PlaybackStateChangedEvent, SessionUser, UserBoard } from '@boardsesh/shared-schema';
import { emitWallConfirm } from '@boardsesh/play-view';
import { GraphQLOperationError, isNotSessionMemberError, subscribe } from '@boardsesh/graphql-client';
import { getWsClient } from '../../lib/graphql/ws-client';
import { AUTH_REFRESH_RETRY_CLOSE_CODE } from '../../lib/graphql/ws-close-codes';
import {
  QUEUE_UPDATES_SUBSCRIPTION,
  SESSION_UPDATES_SUBSCRIPTION,
  type SessionUpdateEvent,
  type SessionLiveStatsEvent,
} from '../../lib/graphql/operations';
import { getConnectivitySnapshot, subscribeConnectivity } from '../../lib/connectivity/connectivity-store';
import { getStoredActiveBoard } from '../../lib/active-board-store';
import { clearStoredQueueSnapshot } from '../../lib/queue-snapshot-store';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../../lib/queue-conversion';
import { toMobileSessionRuntimeEvent } from '../../lib/session-runtime-event';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import type { ToastVariant } from '../../components/Toast';

const JOIN_SESSION_RETRY_BACKOFF_MS = [1_000, 2_500, 5_000] as const;
// ws-client remaps a rejected-auth 4401 to the retryable AUTH_REFRESH_RETRY_CLOSE_CODE
// (imported above) at the transport boundary. Unlike an ordinary socket drop,
// this retry must keep established graphql-ws operations alive so its lazy
// client still has work to reconnect and resubscribe. The authenticated
// durable-membership fast path on the backend authorizes those subscriptions
// while JOIN_SESSION rebinds the fresh connection context in parallel.

function getCloseEventCode(closeEvent: unknown): number | null {
  if (typeof closeEvent !== 'object' || closeEvent === null || !('code' in closeEvent)) return null;
  return typeof closeEvent.code === 'number' ? closeEvent.code : null;
}

// The wire envelope shape matches what QUEUE_UPDATES_SUBSCRIPTION returns —
// the subscription aliases `item`→`addedItem` (disambiguates from the
// overlapping `item` selection on CurrentClimbChanged) and `uuid`→`mirroredUuid`
// (disambiguates from QueueItemRemoved.uuid). Both aliases are first-class on
// `SubscriptionWireEnvelope` so we can use the wire type directly.
type QueueUpdateEvent = SubscriptionWireEnvelope<SubscriptionQueueItem>;
export type MobileSessionRuntimeState = RuntimeSessionState<SessionUser>;

/**
 * Flatten a raw queueUpdates wire event into the shape createQueueSyncGate's
 * `evaluateIncoming`/`noteApplied` expect. Every variant except FullSync
 * already carries a top-level `stateHash` matching
 * QUEUE_UPDATES_SUBSCRIPTION's selection (`... on QueueItemAdded { sequence
 * stateHash ... }`, etc.) — FullSync's `stateHash` is nested one level
 * deeper instead (the subscription selects `state { stateHash ... }`, with
 * no top-level `stateHash` for that variant), so pull it out here. Mirrors
 * `sync-gate.ts`'s own doc: "for FullSync, pass `stateHash:
 * event.state.stateHash` since the real wire event nests it under `state`."
 * Widening `SubscriptionWireEnvelope`'s FullSync member instead would ripple
 * into every other consumer of that shared type, so the flatten stays local.
 */
function toSyncQueueEvent(event: QueueUpdateEvent): QueueSyncGateEvent {
  if (event.__typename === 'FullSync') {
    return {
      __typename: 'FullSync',
      sequence: event.sequence,
      stateHash: event.state.stateHash ?? null,
      // Order-sensitive (v2) hash — nested under `state` like stateHash. Rides
      // through to the gate so it can prefer ordered-vs-ordered on reorder drift.
      stateHashOrdered: event.state.stateHashOrdered ?? null,
    };
  }
  // Non-FullSync variants carry `stateHash`/`stateHashOrdered` at the top level
  // (matching the subscription selection), so the raw envelope is already a
  // valid QueueSyncGateEvent — the ordered hash flows through untouched.
  return event;
}

export const createEmptySessionRuntimeState = (): MobileSessionRuntimeState => ({
  users: [],
  isLeader: false,
  clientId: '',
  participantId: '',
  lastConnectedBoardSerial: null,
  boardPath: '',
});

/**
 * Order-insensitive signature of the roster fields a SessionRosterSnapshot can
 * change (crew membership + per-user leadership + display name + connection
 * state, own leadership, boardPath). Used only to decide whether a seed/reconcile
 * snapshot actually healed dropped roster drift, so we emit `Session Roster
 * Reconciled` telemetry only when the crew list really moved — not on every
 * (re)subscribe. `connectionState` is included so a snapshot that heals a
 * presence-only drift (e.g. a dropped UserPresenceChanged flipping
 * CONNECTED↔RECONNECTING) still registers — the gating metric would otherwise
 * miss exactly the drift it exists to measure.
 */
function rosterStateSignature(state: MobileSessionRuntimeState): string {
  const users = state.users
    .map((user) => `${user.id}:${user.isLeader ? 1 : 0}:${user.username}:${user.connectionState ?? ''}`)
    .sort()
    .join('|');
  return `${users}#${state.isLeader ? 1 : 0}#${state.boardPath}`;
}

type UseSessionRealtimeParams = {
  authTransportRevision: number;
  sessionId: string | null;
  dispatch: React.Dispatch<QueueAction>;
  coordinator: { clientId: string };
  ensureJoined: (sessionIdToJoin: string) => Promise<unknown>;
  joinTracker: { reset: () => void; bumpEpoch: () => void };
  sessionIdRef: React.RefObject<string | null>;
  participantIdRef: React.RefObject<string | null>;
  stateRef: React.RefObject<QueueState>;
  /**
   * Set by createSessionWithConfig to the id of a session whose local-queue seed
   * failed. While it matches this session, the empty-room FullSync is treated as
   * a stale artefact of the failed seed rather than authoritative: it's skipped
   * (dispatch AND gate tracking) so it can't wipe the live queue, and a re-seed
   * via `reSeedQueueRef` re-pushes the local queue (#3878).
   */
  seedFailedSessionIdRef: React.RefObject<string | null>;
  /** `mutations.setQueue` — re-pushes the whole local queue when the empty-room
   *  FullSync guard fires, so the server catches up to local instead of local
   *  being clobbered down to the empty room. Self-joins via ensureReady. */
  reSeedQueueRef: React.RefObject<
    (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => Promise<void>
  >;
  activeBoardRef: React.RefObject<UserBoard | null | undefined>;
  setActiveBoardRef: React.RefObject<(board: UserBoard) => Promise<void>>;
  showToastRef: React.RefObject<(message: string, variant?: ToastVariant, duration?: number) => void>;
  tRef: React.RefObject<(key: string) => string>;
  clearSessionRef: React.RefObject<(options?: { notifyServer?: boolean }) => Promise<void>>;
  playbackEventListenersRef: React.RefObject<Set<(event: PlaybackStateChangedEvent) => void>>;
  unsubscribeRef: React.RefObject<(() => void) | null>;
  queueSyncGateRef: React.RefObject<QueueSyncGate | null>;
  restartJoinedSubscriptionsRef: React.RefObject<(() => void) | null>;
  resyncQueueFromServerRef: React.RefObject<() => Promise<boolean>>;
  setLiveStats: React.Dispatch<React.SetStateAction<SessionLiveStatsEvent | null>>;
  setSessionRuntimeState: React.Dispatch<React.SetStateAction<MobileSessionRuntimeState>>;
  sessionRuntimeStateRef: React.RefObject<MobileSessionRuntimeState>;
  /** Requested boardPath of a local angle change whose broadcast is still in
   *  flight, else null. Gates the snapshot angle-follow (see below). */
  pendingLocalBoardPathRef: React.RefObject<string | null>;
  setIsSessionWallLit: React.Dispatch<React.SetStateAction<boolean>>;
  setParticipantId: React.Dispatch<React.SetStateAction<string | null>>;
  locallyEndingSessionIdRef: React.RefObject<string | null>;
  suppressedRemoteEndSessionIdRef: React.RefObject<string | null>;
};

/**
 * The active session's realtime engine: join retry/backoff, the queueUpdates +
 * sessionUpdates subscriptions, sync-gate wiring, roster/liveStats/wall-lit
 * updates, peer angle-follow, and the 60s hash watchdog. All outputs flow
 * through the passed-in setters/refs; the provider still owns the state and
 * refs so `resyncQueueFromServer` (which stays there) can read the gate and
 * restart the subscriptions.
 */
export function useSessionRealtime({
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
}: UseSessionRealtimeParams): void {
  // Read the QueryClient off its context directly (rather than useQueryClient,
  // which throws without a provider) so the always-mounted provider stays
  // renderable in isolation-mounted tests that don't set one up. In the app it's
  // always present. Stable across renders — safe to read inside the subscription
  // closure without threading it through the effect deps.
  const queryClient = useContext(QueryClientContext);

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
      pendingLocalBoardPathRef.current = null;
      queueSyncGateRef.current = null;
      restartJoinedSubscriptionsRef.current = null;
      return;
    }

    const wsClient = getWsClient();
    // One sync gate per session — this effect re-runs (and creates a fresh
    // gate) on every session change; `unsubClosed` below calls `gate.reset()`
    // mid-session on a socket drop (same session, but the connection's
    // ConnectionContext and in-flight sequence tracking are no longer valid).
    const gate = createQueueSyncGate();
    queueSyncGateRef.current = gate;
    let disposed = false;
    let subscriptionStartToken = 0;
    let queueUpdatesCleanup: (() => void) | null = null;
    let sessionUpdatesCleanup: (() => void) | null = null;
    let joinRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let joinRetryCount = 0;
    let authRefreshRejoinInProgress = false;

    // Single-flight, snapshot-checked recovery for a failed session seed. The
    // empty-room FullSync guard (below) calls this to re-push the local queue so
    // the server catches up. Serialised so a live queue edit or a second empty
    // FullSync mid-flight can't race two whole-queue writes — an older setQueue
    // landing last would regress newer state. The seed-failed flag clears only
    // once the pushed snapshot still matches local (else the latest state is
    // re-pushed), and a converged re-seed also drops the solo snapshot, mirroring
    // the happy-path seed in createSessionWithConfig so a stale copy can't
    // resurrect the pre-session queue on a later cold start. Effect-scoped, so it
    // survives subscription restarts within the session and resets per session.
    let reSeedInFlight = false;
    // `triggeredByFullSync` keeps `Queue Seed FullSync Guarded` faithful to its
    // name: exactly one event per empty FullSync we actually guarded and turned
    // into a write. Only the FullSync handler below passes `true`. It is checked
    // AFTER the single-flight and empty-queue guards, so a second empty FullSync
    // arriving mid-re-seed — which correctly no-ops the write — no longer counts.
    // The internal convergence re-push at the `.then` below passes nothing: no
    // FullSync triggered it, so counting it would overcount by one per local
    // queue edit that lands mid-push.
    const reSeedQueueAfterFailedSeed = (triggeredByFullSync = false) => {
      if (reSeedInFlight) return;
      const { queue, currentClimbQueueItem } = stateRef.current;
      if (queue.length === 0 && currentClimbQueueItem == null) return;
      if (triggeredByFullSync) {
        track(SHARED_EVENTS.QueueSeedFullSyncGuarded, {
          boardName: activeBoardRef.current?.boardType,
          layoutId: activeBoardRef.current?.layoutId,
          localQueueLength: queue.length,
        });
      }
      reSeedInFlight = true;
      const pushedHash = computeQueueStateHashOrdered(queue, currentClimbQueueItem?.uuid ?? null);
      void reSeedQueueRef
        .current(queue, currentClimbQueueItem ?? undefined)
        .then(() => {
          reSeedInFlight = false;
          if (sessionIdRef.current !== sessionId) return;
          const { queue: latestQueue, currentClimbQueueItem: latestCurrent } = stateRef.current;
          const latestHash = computeQueueStateHashOrdered(latestQueue, latestCurrent?.uuid ?? null);
          if (latestHash !== pushedHash) {
            // Local changed while the push was in flight — re-push the latest and
            // keep the guard armed until a push reflects the current queue. No
            // FullSync drove this re-push, so it stays untracked (see above).
            reSeedQueueAfterFailedSeed();
            return;
          }
          // Server now matches local: retire the guard and drop the solo snapshot.
          seedFailedSessionIdRef.current = null;
          void clearStoredQueueSnapshot();
        })
        .catch((reSeedError) => {
          reSeedInFlight = false;
          if (__DEV__) console.warn('[queue] session queue re-seed failed', reSeedError);
          reportHandledError(reSeedError, { tags: { source: 'startSessionSeed', op: 'reseed' } });
          // Flag stays set: the next reconnect's empty FullSync retries.
        });
    };

    // iOS suspends the WebSocket while the app is backgrounded, so a
    // JOIN_SESSION fired now never completes and trips execute()'s 30s timeout
    // — reported as a noisy `queue-sync/join` error even though it's expected
    // (#3605). Track a deferral so the join re-runs on foreground. Gate only on
    // `background`, not the transient iOS `inactive` (matching app-visibility.ts),
    // so notification-center / app-switcher blips don't tear a live session down.
    let joinDeferredForBackground = false;
    const isBackgrounded = () => AppState.currentState === 'background';

    // The same idea for a backend we already know we can't reach: while the
    // connectivity store says we're effectively offline (offline mode, no
    // device network, or a backend that failed its probe), a JOIN_SESSION can
    // only time out. Park it here and let the connectivity listener below
    // re-run the join on the edge back to reachable (#4862).
    let joinDeferredForConnectivity = false;

    const clearJoinRetryTimer = () => {
      if (!joinRetryTimer) return;
      clearTimeout(joinRetryTimer);
      joinRetryTimer = null;
    };

    const cleanupSubscriptions = () => {
      clearJoinRetryTimer();
      authRefreshRejoinInProgress = false;
      queueUpdatesCleanup?.();
      sessionUpdatesCleanup?.();
      queueUpdatesCleanup = null;
      sessionUpdatesCleanup = null;
      unsubscribeRef.current = null;
    };

    const logJoinFailure = (err: unknown) => {
      if (__DEV__) console.warn('[queue] joinSession failed', err);
    };

    // Follow a session boardPath's angle onto our own active board. Shared by the
    // SessionBoardPathChanged delta AND the SessionRosterSnapshot seed so a
    // dropped path change is healed on the next (re)subscribe, not left stale on
    // the wall until another peer changes the angle (PR #3907 Codex thread).
    // Idempotent: every branch no-ops when the stored angle already matches, when
    // the board is fixed-angle, or when the peer is on a different board — so
    // calling it on every snapshot is safe.
    const followSessionBoardPath = (boardPath: string) => {
      // Named-board hosts (`/b/{slug}`) broadcast a slug path the tuple parser
      // rejects. Follow the angle when we're on the SAME named board (slug match)
      // — the angle table differs per board, so never cross boards.
      const named = parseNamedBoardPath(boardPath);
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
      const parsed = parseBoardPath(boardPath);
      if (!parsed || parsed.angle == null) return;
      const nextAngle = parsed.angle;
      void (async () => {
        const stored = await getStoredActiveBoard();
        if (sessionIdRef.current !== sessionId) return;
        if (!stored || stored.angle === nextAngle) return;
        // Never override a fixed-angle board (mirrors handleAngleChange's local
        // guard) — a peer can't change an angle the board can't be set to.
        if (stored.isAngleAdjustable === false) return;
        // Follow ONLY the angle, and only when the peer is on the SAME board. A
        // mixed-board session must not push a foreign angle (board angle tables
        // differ, e.g. MoonBoard only allows 25°/40°).
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
    };

    // Only reached from the join catch below, AFTER its own offline gate, so a
    // retry is never armed against a server the store says is unreachable.
    const scheduleJoinRetry = (failedStartToken: number, preserveExistingSubscriptions = false) => {
      const retryDelayMs =
        JOIN_SESSION_RETRY_BACKOFF_MS[Math.min(joinRetryCount, JOIN_SESSION_RETRY_BACKOFF_MS.length - 1)];
      joinRetryCount++;
      joinRetryTimer = setTimeout(() => {
        joinRetryTimer = null;
        if (disposed || failedStartToken !== subscriptionStartToken || sessionIdRef.current !== sessionId) return;
        void startJoinedSubscriptions(preserveExistingSubscriptions);
      }, retryDelayMs);
    };

    const startJoinedSubscriptions = async (preserveExistingSubscriptions = false) => {
      // While backgrounded the socket is suspended: defer the join instead of
      // firing one that can only time out (#3605). Supersede any in-flight join
      // (bump the token), tear down subscriptions, and let the AppState listener
      // below re-run us on foreground. Reset the retry counter so the foreground
      // re-join is a fresh attempt cycle whose first failure still toasts +
      // reports (the `joinRetryCount === 0` guard below).
      if (isBackgrounded()) {
        subscriptionStartToken++;
        joinDeferredForBackground = true;
        joinRetryCount = 0;
        cleanupSubscriptions();
        return;
      }

      // Same shape for an effectively-offline app: the offline banner already
      // owns the message, a join can only time out against an unreachable
      // server, and looping every 5s burns battery for nothing (#4862).
      // Supersede any in-flight join and tear down, exactly like the
      // background branch — the connectivity listener re-joins on the edge.
      if (getConnectivitySnapshot().effectiveOffline) {
        subscriptionStartToken++;
        joinDeferredForConnectivity = true;
        joinRetryCount = 0;
        cleanupSubscriptions();
        return;
      }

      // Past both gates, so this run IS the resume for whichever deferral(s)
      // were armed. Clear both flags here rather than in the listeners: the
      // app can be backgrounded and offline at once, and on recovery the
      // connectivity store's own AppState subscriber runs before this effect's,
      // so the connectivity listener would join first and the AppState listener
      // would then find its flag still set and join a second time — a duplicate
      // JOIN_SESSION plus a teardown/resubscribe of both streams.
      joinDeferredForBackground = false;
      joinDeferredForConnectivity = false;

      const currentStartToken = ++subscriptionStartToken;
      const retainedQueueUpdatesCleanup = preserveExistingSubscriptions ? queueUpdatesCleanup : null;
      const retainedSessionUpdatesCleanup = preserveExistingSubscriptions ? sessionUpdatesCleanup : null;
      if (preserveExistingSubscriptions) {
        clearJoinRetryTimer();
      } else {
        cleanupSubscriptions();
      }

      try {
        await ensureJoined(sessionId);
      } catch (joinError) {
        if (disposed || currentStartToken !== subscriptionStartToken || sessionIdRef.current !== sessionId) return;
        // A join in flight when the app backgrounds can't complete over the
        // suspended socket and hits the 30s timeout (#3605). That's expected,
        // not a defect: skip the toast + error report and defer — the AppState
        // listener re-joins on foreground. Reset the retry counter so that
        // foreground re-join's first failure still surfaces (see the gate above).
        if (isBackgrounded()) {
          joinDeferredForBackground = true;
          joinRetryCount = 0;
          clearJoinRetryTimer();
          return;
        }
        // The party session already ended server-side (leader ended it, or it
        // was reaped) while we were joining/rejoining — expected teardown, not
        // a sync failure. Mirrors web's SESSION_ENDED guard
        // (session-connection-ports.ts) and this file's own NOT_SESSION_MEMBER
        // subscription-error branch. Unlike that branch this toasts: a client
        // whose join fails here never receives the live `SessionEnded`
        // subscription event (which does toast), so this is often the only
        // signal the user gets that the session is gone. A late error from a
        // superseded A→B switch is already dropped by the guard at the top of
        // this catch block, so it can't clear the new session.
        if (joinError instanceof GraphQLOperationError && joinError.extensions?.code === 'SESSION_ENDED') {
          void clearSessionRef.current();
          showToastRef.current(tRef.current('mobile.toast.sessionEnded'), 'success');
          return;
        }
        // An outage, not a defect: the connectivity store says we're
        // effectively offline, so this join never had a server to reach. The
        // offline banner says it once — a `syncError` toast plus a Sentry
        // report on top of it is noise, and the retry below would keep firing
        // at the clamped 5s backoff (#4862). Defer instead; the connectivity
        // listener re-joins on the edge. Deliberately checked AFTER the
        // SESSION_ENDED branch: that code can only come back from a backend
        // that answered, so it stays authoritative even if offline mode
        // flipped on while this join was in flight.
        if (getConnectivitySnapshot().effectiveOffline) {
          joinDeferredForConnectivity = true;
          joinRetryCount = 0;
          clearJoinRetryTimer();
          return;
        }
        logJoinFailure(joinError);
        if (joinRetryCount === 0) {
          showToastRef.current(tRef.current('mobile.queue.syncError'), 'error');
          reportHandledError(joinError, { tags: { source: 'queue-sync', op: 'join' } });
        }
        scheduleJoinRetry(currentStartToken, preserveExistingSubscriptions);
        return;
      }

      if (disposed || currentStartToken !== subscriptionStartToken || sessionIdRef.current !== sessionId) return;
      joinRetryCount = 0;

      queueUpdatesCleanup = subscribe<{ queueUpdates: QueueUpdateEvent }>(
        wsClient,
        {
          query: QUEUE_UPDATES_SUBSCRIPTION,
          variables: { sessionId },
        },
        {
          next: (data) => {
            if (!data?.queueUpdates) return;
            const event = data.queueUpdates;
            // PlaybackStateChanged is a first-class wire variant but carries no
            // queue state. Forward it to route-playback listeners, then stop
            // before item lifting, the reducer, and sequence/hash tracking.
            if (event.__typename === 'PlaybackStateChanged') {
              for (const listener of playbackEventListenersRef.current) {
                try {
                  listener(event);
                } catch (listenerError) {
                  if (__DEV__) console.warn('[queue] playback-event listener threw', listenerError);
                }
              }
              return;
            }

            // A brand-new session whose local-queue seed failed
            // (createSessionWithConfig — a network blip, a rate limit, a
            // validation reject, a timeout) still gets an initial FullSync for
            // the empty server room. Applying it would wipe the live local queue
            // via INITIAL_QUEUE_DATA; letting the sync gate adopt the empty
            // room's hash would then have the 60s watchdog resync-to-empty
            // seconds later. While the seed is known-failed for THIS session and
            // local state is still non-empty, treat the local queue as
            // authoritative: skip the empty FullSync entirely (dispatch AND gate
            // tracking, so `lastServerStateHash` stays null and the watchdog
            // stays quiet), and re-push the whole queue so the server catches up.
            // The re-seed (reSeedQueueAfterFailedSeed) is single-flight and
            // snapshot-checked: it clears the flag only when the pushed snapshot
            // still matches local, else re-pushes the latest — so a live edit or
            // a second empty FullSync mid-flight can't race two whole-queue
            // writes. `reSeedQueueRef` (mutations.setQueue) self-joins.
            if (event.__typename === 'FullSync' && seedFailedSessionIdRef.current === sessionId) {
              const isEmptyRoom = event.state.queue.length === 0 && event.state.currentClimbQueueItem == null;
              const { queue: localQueue, currentClimbQueueItem: localCurrent } = stateRef.current;
              const hasLocalQueue = localQueue.length > 0 || localCurrent != null;
              if (isEmptyRoom && hasLocalQueue) {
                if (__DEV__) console.warn('[queue] guarding empty FullSync after failed seed; re-seeding');
                reSeedQueueAfterFailedSeed(true);
                return;
              }
              // Local is also empty (nothing to protect) or the room isn't empty
              // (the seed actually landed, or a peer populated it before this
              // FullSync) — drop the guard and apply the FullSync normally.
              seedFailedSessionIdRef.current = null;
            }

            // Sequence-gate every other event before touching the reducer. A
            // stale duplicate (already-applied or older sequence — e.g. a
            // redelivered frame after a brief reconnect) is dropped; a
            // sequence gap (missed events) triggers the existing single-flight
            // HTTP resync instead of applying a delta on top of state we know
            // is incomplete.
            const gateEvent = toSyncQueueEvent(event);
            const decision = gate.evaluateIncoming(gateEvent);
            if (decision === 'ignore-stale') {
              if (__DEV__) console.info('[queue] ignoring stale queue event', event.__typename, gateEvent.sequence);
              track(SHARED_EVENTS.QueueSyncStaleEventIgnored, {
                eventType: event.__typename,
                sequence: gateEvent.sequence ?? null,
                boardName: activeBoardRef.current?.boardType,
                layoutId: activeBoardRef.current?.layoutId,
              });
              return;
            }
            if (decision === 'resync-gap') {
              if (__DEV__)
                console.warn('[queue] sequence gap on queue event; resyncing', event.__typename, gateEvent.sequence);
              track(SHARED_EVENTS.QueueSyncGapResync, {
                eventType: event.__typename,
                sequence: gateEvent.sequence ?? null,
                boardName: activeBoardRef.current?.boardType,
                layoutId: activeBoardRef.current?.layoutId,
              });
              void resyncQueueFromServerRef.current();
              return;
            }

            const result = mapSubscriptionEnvelopeToAction(event, {
              mapItem: toClimbQueueItem,
              context: { myClientId: coordinator.clientId },
            });
            // Advance the gate's sequence/hash tracking for every applied
            // event, whether or not it produced a dispatchable action — mirrors
            // web's use-event-processor.ts, which updates tracking
            // unconditionally after the switch that processes the delta (e.g.
            // a QueueItemAdded with a null item payload still consumes its
            // sequence slot).
            gate.noteApplied(gateEvent);
            if (result.kind !== 'dispatch') return;
            dispatch(result.action);
            switch (result.eventType) {
              case 'QueueItemAdded': {
                // The server echoes our own adds back to us. A locally
                // initiated add already tracked itself with its real source tab
                // at the mutation site (queue-provider.tsx), so tracking the
                // echo would double count — stay silent rather than emit a
                // second, peer-attributed copy (#4042).
                //
                // Both truthiness guards are load-bearing: solo/unjoined state
                // leaves clientId as '' (createEmptySessionRuntimeState) and a
                // pre-#4042 server sends no clientId at all. Either way we fall
                // back to today's 'peer_broadcast' attribution.
                //
                // The `__typename` re-check is load-bearing, not dead code:
                // this switch discriminates on `result.eventType`, a separate
                // variable, so `event` is still the full union here and TS
                // rejects `event.clientId` without it. Compare against the
                // joinSession-returned clientId in sessionRuntimeStateRef — NOT
                // coordinator.clientId, which is generated locally and never
                // reaches the server.
                const selfAddClientId = sessionRuntimeStateRef.current?.clientId;
                if (
                  event.__typename === 'QueueItemAdded' &&
                  event.clientId &&
                  selfAddClientId &&
                  event.clientId === selfAddClientId
                ) {
                  break;
                }
                track(SHARED_EVENTS.ClimbAddedToQueue, {
                  boardName: activeBoardRef.current?.boardType,
                  layoutId: activeBoardRef.current?.layoutId,
                  addedFromTab: 'peer_broadcast',
                  currentQueueLength: stateRef.current.queue.length + 1,
                  partyMode: true,
                });
                break;
              }
              case 'QueueItemRemoved': {
                // The server echoes our own removes back to us. A locally
                // initiated remove already tracked itself with
                // removedBy: 'self' at the mutation site (queue-provider.tsx),
                // so tracking the echo would double count — stay silent rather
                // than emit a second, peer-attributed copy (#3382).
                //
                // Both truthiness guards are load-bearing: solo/unjoined state
                // leaves clientId as '' (createEmptySessionRuntimeState) and a
                // pre-#3382 server sends no clientId at all. Either way we fall
                // back to today's 'peer' attribution.
                //
                // The `__typename` re-check is load-bearing, not dead code:
                // this switch discriminates on `result.eventType`, a separate
                // variable, so `event` is still the full union here and TS
                // rejects `event.clientId` without it.
                const selfClientId = sessionRuntimeStateRef.current?.clientId;
                if (
                  event.__typename === 'QueueItemRemoved' &&
                  event.clientId &&
                  selfClientId &&
                  event.clientId === selfClientId
                ) {
                  break;
                }
                track(SHARED_EVENTS.ClimbRemovedFromQueue, {
                  boardName: activeBoardRef.current?.boardType,
                  layoutId: activeBoardRef.current?.layoutId,
                  partyMode: true,
                  removedBy: 'peer',
                });
                break;
              }
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
          error: (subscriptionError) => {
            // The server denied our queue subscription because this connection
            // isn't a member of the session (NOT_SESSION_MEMBER). Post-#3695 an
            // authenticated member reconnecting is re-authorized instantly, so
            // reaching here means the session is genuinely gone for us
            // (ended / emptied / a stale pointer) — clear the local session
            // silently. A "Queue sync error" toast for a session that no longer
            // exists is just noise. (#2385 follow-up.) Guarded on the still-
            // active session so a late error from a superseded A→B switch can't
            // clear the new session.
            if (
              sessionIdRef.current === sessionId &&
              isNotSessionMemberError(subscriptionError) &&
              !authRefreshRejoinInProgress
            ) {
              void clearSessionRef.current();
              return;
            }
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
      sessionUpdatesCleanup = subscribe<{ sessionUpdates: SessionUpdateEvent }>(
        wsClient,
        {
          query: SESSION_UPDATES_SUBSCRIPTION,
          variables: { sessionId },
        },
        {
          next: (data) => {
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

            if (event.__typename === 'SessionNameChanged') {
              // A member (or an HTTP updateSession) renamed the session. Our own
              // renames go over HTTP, so changedByParticipantId is null and we
              // can't echo-suppress by participant id — just invalidate both
              // title sources. The preview matters for zero-tick sessions, where
              // sessionDetail is null; our own optimistic write already updated
              // the caches locally, so the extra refetch is cheap and
              // self-consistent.
              void queryClient?.invalidateQueries({ queryKey: ['sessionPreview', sessionId] });
              void queryClient?.invalidateQueries({ queryKey: ['sessionDetail', sessionId] });
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
              // Keep the functional updater so rapid consecutive deltas each
              // apply on the truly-latest roster (not a stale render snapshot).
              setSessionRuntimeState(
                (prev) => applySessionRuntimeEvent(prev, runtimeEvent) ?? createEmptySessionRuntimeState(),
              );
              // Best-effort drift telemetry: a SessionRosterSnapshot is the only
              // event that can silently heal a dropped roster delta. Detect a
              // real change against the latest-committed mirror (the functional
              // updater's result isn't observable here) and emit only then, so
              // this counts genuine presence-drift heals, not routine reseeds.
              if (runtimeEvent.__typename === 'SessionRosterSnapshot') {
                const prevRoster = sessionRuntimeStateRef.current ?? createEmptySessionRuntimeState();
                const nextRoster =
                  applySessionRuntimeEvent(prevRoster, runtimeEvent) ?? createEmptySessionRuntimeState();
                if (rosterStateSignature(prevRoster) !== rosterStateSignature(nextRoster)) {
                  track(SHARED_EVENTS.SessionRosterReconciled, {
                    userCount: nextRoster.users.length,
                    boardName: activeBoardRef.current?.boardType,
                    layoutId: activeBoardRef.current?.layoutId,
                  });
                }
                // Heal a dropped SessionBoardPathChanged: the snapshot carries the
                // authoritative boardPath, so re-run the angle-follow. Empty is the
                // "keep current" sentinel — skip it. No echo suppression needed:
                // a reconcile snapshot has no originating participant.
                //
                // BUT skip while a local angle change is still broadcasting: the
                // snapshot may have been seeded before our setSessionBoardPath
                // landed, so it carries the OLD boardPath and would revert the wall
                // off the angle we just picked — and our own SessionBoardPathChanged
                // echo is self-suppressed, leaving us stuck. Once the broadcast
                // settles the backend holds our value and later snapshots agree, so
                // the follow resumes. (A snapshot seeded pre-persist but delivered
                // post-settle is a narrower race that needs a roster epoch to
                // resolve — deferred with the periodic-resnapshot healer, #3905.)
                if (runtimeEvent.boardPath && !pendingLocalBoardPathRef.current) {
                  followSessionBoardPath(runtimeEvent.boardPath);
                }
              }
            }

            // Follow a peer's angle change directly from the delta.
            if (event.__typename === 'SessionBoardPathChanged' && event.boardPath) {
              // Echo of our own change — we already applied it locally before
              // broadcasting. A null local participant id (peer event before our
              // JOIN_SESSION resolved) can't be the originator, so we apply it.
              if (event.changedByParticipantId && event.changedByParticipantId === participantIdRef.current) return;
              followSessionBoardPath(event.boardPath);
            }
          },
          error: (sessionSubscriptionError) => {
            // Session-update stream errors were swallowed. Surface them for
            // triage (the retained subscription still drives its own reconnect).
            reportHandledError(sessionSubscriptionError);
          },
          complete: () => {},
        },
      );

      // Retained operations keep graphql-ws's lazy reconnect alive, but a replay
      // can be rejected before JOIN_SESSION updates the new connection context.
      // Once joined, replace both streams before releasing the retained handles
      // so the active-operation count never reaches zero.
      if (preserveExistingSubscriptions) {
        retainedQueueUpdatesCleanup?.();
        retainedSessionUpdatesCleanup?.();
        authRefreshRejoinInProgress = false;
      }

      unsubscribeRef.current = cleanupSubscriptions;
    };

    // graphql-ws auto-reconnects, and every reconnect gives us a fresh
    // per-connection ConnectionContext on the backend. Ordinary drops retain
    // the existing join-before-new-subscriptions flow. A rejected-auth retry is
    // different: cancelling the established operations drops the lazy client's
    // active-operation count to zero and aborts the retry that ws-client just
    // initiated. Preserve those operations only for that transport-remapped
    // close; authenticated durable membership authorizes their resubscription
    // while JOIN_SESSION rebinds the connection context in parallel.
    let preserveSubscriptionsOnNextConnect = false;
    const unsubClosed = wsClient.on('closed', (closeEvent) => {
      joinTracker.bumpEpoch();
      subscriptionStartToken++;
      joinRetryCount = 0;
      const hasEstablishedSubscriptions = queueUpdatesCleanup !== null && sessionUpdatesCleanup !== null;
      if (getCloseEventCode(closeEvent) === AUTH_REFRESH_RETRY_CLOSE_CODE && hasEstablishedSubscriptions) {
        preserveSubscriptionsOnNextConnect = true;
        authRefreshRejoinInProgress = true;
        clearJoinRetryTimer();
        gate.reset();
        return;
      }
      preserveSubscriptionsOnNextConnect = false;
      cleanupSubscriptions();
      // The reconnect's FullSync re-baselines tracking on its own
      // (evaluateIncoming always applies + resets a FullSync), but reset here
      // too so a stray in-flight event from the dead connection can't be
      // sequence-checked against the old connection's tracking in the gap
      // before that FullSync arrives.
      gate.reset();
    });
    const unsubConnected = wsClient.on('connected', () => {
      const preserveExistingSubscriptions = preserveSubscriptionsOnNextConnect;
      preserveSubscriptionsOnNextConnect = false;
      void startJoinedSubscriptions(preserveExistingSubscriptions);
    });

    // Re-run a join deferred while backgrounded once the app returns to the
    // foreground: the socket is usable again, so the JOIN_SESSION we skipped (or
    // that timed out on the suspended socket) can now complete (#3605). Gate on
    // `active` only — `inactive` is a transient interruption where the socket is
    // still fine.
    const appStateSub = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active' && joinDeferredForBackground) {
        joinDeferredForBackground = false;
        void startJoinedSubscriptions();
      }
    });

    // The connectivity mirror of that listener: restart a join parked by any of
    // the three gates above once the app is no longer effectively offline. The
    // listener fires on every snapshot change (backend probe result, device
    // reachability, offline-mode toggle), so the flag is what keeps this to
    // exactly one restart per deferral — an unrelated field moving inside the
    // snapshot must not re-enter the join path.
    const unsubscribeConnectivity = subscribeConnectivity(() => {
      if (!getConnectivitySnapshot().effectiveOffline && joinDeferredForConnectivity) {
        joinDeferredForConnectivity = false;
        void startJoinedSubscriptions();
      }
    });

    // Expose the restart path for resyncQueueFromServer's membership
    // fallback (see there): startJoinedSubscriptions bumps the start token
    // and tears down first, so an external call is exactly as safe as the
    // reconnect path calling it. Nulled on teardown so a stale closure from
    // a previous session can never be invoked.
    restartJoinedSubscriptionsRef.current = () => {
      void startJoinedSubscriptions();
    };

    void startJoinedSubscriptions();

    return () => {
      disposed = true;
      subscriptionStartToken++;
      restartJoinedSubscriptionsRef.current = null;
      cleanupSubscriptions();
      unsubConnected();
      unsubClosed();
      appStateSub.remove();
      unsubscribeConnectivity();
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
      // Drop any pending board-path guard from the outgoing session: if its
      // setSessionBoardPath hung on a wedged socket during an A→B switch, a stale
      // ref would otherwise suppress every snapshot angle-follow in session B.
      pendingLocalBoardPathRef.current = null;
    };
  }, [sessionId, coordinator, ensureJoined, joinTracker, authTransportRevision]);

  // Periodic local-vs-server hash watchdog (mirrors web's 60s interval in
  // use-session-subscriptions.ts, ported into the shared gate's
  // verifyLocalHash). Active only while a session is live; reads current
  // state through refs (stateRef, queueSyncGateRef, resyncQueueFromServerRef)
  // so the closure never goes stale between renders — `sessionId` is the only
  // dependency, matching this file's existing ref-driven interval pattern.
  useEffect(() => {
    if (!sessionId) return undefined;
    const verifyIntervalId = setInterval(() => {
      const gate = queueSyncGateRef.current;
      if (!gate) return;
      const { queue, currentClimbQueueItem } = stateRef.current;
      // Compute both hashes; the gate prefers the ordered (v2) comparison when
      // the server sent an ordered hash, else falls back to v1. `localHash` (v1)
      // is retained for the drift log/analytics below.
      const localHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid ?? null);
      const localHashOrdered = computeQueueStateHashOrdered(queue, currentClimbQueueItem?.uuid ?? null);
      const result = gate.verifyLocalHash({ stateHash: localHash, stateHashOrdered: localHashOrdered });
      if (result.verdict === 'ok') return;

      if (result.verdict === 'resync-drift') {
        if (__DEV__) {
          console.warn(
            '[queue] hash drift detected; resyncing',
            `localV1=${localHash} localV2=${localHashOrdered} server(compared)=${result.serverHash} strikes=${result.consecutiveResyncs}`,
          );
        }
        track(SHARED_EVENTS.QueueSyncHashDrift, {
          verdict: result.verdict,
          consecutiveResyncs: result.consecutiveResyncs,
          boardName: activeBoardRef.current?.boardType,
          layoutId: activeBoardRef.current?.layoutId,
        });
        void resyncQueueFromServerRef.current();
        return;
      }

      // 'backoff' — the same server hash has triggered RESYNC_LOOP_THRESHOLD
      // consecutive resyncs without the drift resolving. Report it so we can
      // investigate, but STOP resyncing: once this happens the resync is a
      // server-side no-op (the client and server already agree — the local
      // computation keeps disagreeing with itself), so retrying every minute
      // is just noise.
      if (__DEV__) {
        console.warn(
          '[queue] hash drift backoff — resync loop threshold hit',
          `localV1=${localHash} localV2=${localHashOrdered} server(compared)=${result.serverHash} strikes=${result.consecutiveResyncs}`,
        );
      }
      // Report to analytics ONCE per drift streak — the first backoff tick
      // (strike THRESHOLD+1). A session stuck in drift would otherwise emit
      // an event every 60s for hours. The gate resets the counter when the
      // hashes agree or the server hash changes, so a genuinely new streak
      // reports again. Web one-shots its Sentry report at the same point
      // (use-session-subscriptions.ts's sentryReportedHashRef).
      if (result.consecutiveResyncs === RESYNC_LOOP_THRESHOLD + 1) {
        track(SHARED_EVENTS.QueueSyncHashDrift, {
          verdict: result.verdict,
          consecutiveResyncs: result.consecutiveResyncs,
          boardName: activeBoardRef.current?.boardType,
          layoutId: activeBoardRef.current?.layoutId,
        });
      }
    }, 60_000);
    return () => clearInterval(verifyIntervalId);
  }, [sessionId]);
}
