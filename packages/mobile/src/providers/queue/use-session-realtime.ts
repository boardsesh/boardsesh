import { useContext, useEffect } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { computeQueueStateHash, computeQueueStateHashOrdered } from '@boardsesh/queue';
import type { QueueAction, QueueState } from '@boardsesh/queue';
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
import type { SessionUser, SubscriptionQueueEvent, UserBoard } from '@boardsesh/shared-schema';
import { emitWallConfirm } from '@boardsesh/play-view';
import { getWsClient } from '../../lib/graphql/ws-client';
import {
  QUEUE_UPDATES_SUBSCRIPTION,
  SESSION_UPDATES_SUBSCRIPTION,
  type SessionUpdateEvent,
  type SessionLiveStatsEvent,
} from '../../lib/graphql/operations';
import { getStoredActiveBoard } from '../../lib/active-board-store';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../../lib/queue-conversion';
import { toMobileSessionRuntimeEvent } from '../../lib/session-runtime-event';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import type { ToastVariant } from '../../components/Toast';

const JOIN_SESSION_RETRY_BACKOFF_MS = [1_000, 2_500, 5_000] as const;

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
  lastConnectedBoardSerial: null,
  boardPath: '',
});

type UseSessionRealtimeParams = {
  sessionId: string | null;
  dispatch: React.Dispatch<QueueAction>;
  coordinator: { clientId: string };
  ensureJoined: (sessionIdToJoin: string) => Promise<unknown>;
  joinTracker: { reset: () => void; bumpEpoch: () => void };
  sessionIdRef: React.RefObject<string | null>;
  participantIdRef: React.RefObject<string | null>;
  stateRef: React.RefObject<QueueState>;
  activeBoardRef: React.RefObject<UserBoard | null | undefined>;
  setActiveBoardRef: React.RefObject<(board: UserBoard) => Promise<void>>;
  showToastRef: React.RefObject<(message: string, variant?: ToastVariant, duration?: number) => void>;
  tRef: React.RefObject<(key: string) => string>;
  clearSessionRef: React.RefObject<(options?: { notifyServer?: boolean }) => Promise<void>>;
  queueEventListenersRef: React.RefObject<Set<(event: SubscriptionQueueEvent) => void>>;
  unsubscribeRef: React.RefObject<(() => void) | null>;
  queueSyncGateRef: React.RefObject<QueueSyncGate | null>;
  restartJoinedSubscriptionsRef: React.RefObject<(() => void) | null>;
  resyncQueueFromServerRef: React.RefObject<() => Promise<boolean>>;
  setLiveStats: React.Dispatch<React.SetStateAction<SessionLiveStatsEvent | null>>;
  setSessionRuntimeState: React.Dispatch<React.SetStateAction<MobileSessionRuntimeState>>;
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
  sessionId,
  dispatch,
  coordinator,
  ensureJoined,
  joinTracker,
  sessionIdRef,
  participantIdRef,
  stateRef,
  activeBoardRef,
  setActiveBoardRef,
  showToastRef,
  tRef,
  clearSessionRef,
  queueEventListenersRef,
  unsubscribeRef,
  queueSyncGateRef,
  restartJoinedSubscriptionsRef,
  resyncQueueFromServerRef,
  setLiveStats,
  setSessionRuntimeState,
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
            // reuses the room's current sequence, so it bypasses the reducer AND
            // the sync gate below (the gate special-cases this typename too, but
            // returning here keeps this path a true no-op, matching pre-gate
            // behaviour exactly).
            if (queueEvent.__typename === 'PlaybackStateChanged') return;

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
      // The reconnect's FullSync re-baselines tracking on its own
      // (evaluateIncoming always applies + resets a FullSync), but reset here
      // too so a stray in-flight event from the dead connection can't be
      // sequence-checked against the old connection's tracking in the gap
      // before that FullSync arrives.
      gate.reset();
    });
    const unsubConnected = wsClient.on('connected', () => {
      void startJoinedSubscriptions();
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
