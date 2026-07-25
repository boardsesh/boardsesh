import { useCallback, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SubscriptionQueueEvent, SessionEvent, SessionDetail } from '@boardsesh/shared-schema';
import {
  queueReducer,
  initialState as queueInitialState,
  type QueueAction,
  type QueueSearchParams,
  type QueueState,
} from '@boardsesh/queue';
import { mapSubscriptionEnvelopeToAction, type QueueSyncGate, type QueueSyncGateEvent } from '@boardsesh/queue-runtime';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { toWireEnvelope, type QueueStateEvent } from '../event-utils';
import { type SharedRefs, DEBUG } from '../types';
import { SESSION_DETAIL_QUERY_KEY } from '@/app/hooks/use-session-detail';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';

type UseEventProcessorArgs = {
  /**
   * Shared sync gate owned by `PersistentSessionProvider`. The same instance
   * is passed to `useSessionLifecycle` (reconnect strategy + reset on session
   * change/disconnect) and `useSessionSubscriptions` (hash watchdog +
   * corruption cooldown) so every resync decision reads one sequence/hash
   * tracker.
   */
  syncGate: QueueSyncGate;
  refs: Pick<
    SharedRefs,
    | 'lastReceivedSequenceRef'
    | 'triggerResyncRef'
    | 'queueEventSubscribersRef'
    | 'sessionEventSubscribersRef'
    | 'offlineBufferRef'
  >;
};

export type EventProcessorState = {
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  /**
   * W6: the root reducer is now the ONLY queue state — board routes and the
   * off-board bridge both read it instead of keeping their own copies.
   * `playlistSuggestionSource` is client-local queue-UI state (not a backend
   * room field); `pendingCurrentClimbUpdates` is the correlation-id tracker
   * for local->party round trips, garbage-collected by
   * `usePendingUpdateCleanup` (now invoked at the root — see
   * `persistent-session-context.tsx`).
   */
  playlistSuggestionSource: QueueState<QueueSearchParams>['playlistSuggestionSource'];
  pendingCurrentClimbUpdates: string[];
  lastReceivedStateHash: string | null;
  /** Reducer-detected corruption: INITIAL_QUEUE_DATA / UPDATE_QUEUE filtered
   *  null (or climbless) items out of an incoming payload.
   *  `useSessionSubscriptions` watches this and consults the gate's
   *  corruption cooldown before resyncing. */
  needsResync: boolean;
};

export type EventProcessorActions = {
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  /** Acknowledge the reducer's `needsResync` flag after acting on it. */
  clearResyncFlag: () => void;
  notifyQueueSubscribers: (event: SubscriptionQueueEvent) => void;
  notifySessionSubscribers: (event: SessionEvent) => void;
  /**
   * The root reducer's dispatch, exposed so board routes (`GraphQLQueueProvider`)
   * and the off-board bridge (`usePersistentSessionQueueAdapter`) can apply
   * local/optimistic queue actions against the SAME state this processor
   * mirrors from the server. Consumers only ever construct action variants
   * whose payload doesn't depend on `TSearchParams` (DELTA_*, UPDATE_QUEUE,
   * SET_PLAYLIST_SUGGESTION_SOURCE, CLEAR_QUEUE, ...) — `SET_CLIMB_SEARCH_PARAMS`
   * stays board-route-local (see QueueContext's own `climbSearchParams` state).
   */
  dispatch: (action: QueueAction<QueueSearchParams>) => void;
};

/**
 * Flatten a wire event into the shape the sync gate reasons about. FullSync
 * nests its stateHash under `state`; PlaybackStateChanged carries no hash
 * (it doesn't mutate the queue). The order-sensitive `stateHashOrdered` (v2)
 * rides alongside `stateHash` when the backend sends it — the gate prefers it
 * so reorder drift is detectable; an old backend omits it and the gate falls
 * back to v1.
 */
function toGateEvent(event: SubscriptionQueueEvent): QueueSyncGateEvent {
  if (event.__typename === 'FullSync') {
    return {
      __typename: event.__typename,
      sequence: event.sequence,
      stateHash: event.state.stateHash,
      stateHashOrdered: event.state.stateHashOrdered ?? null,
    };
  }
  if (event.__typename === 'PlaybackStateChanged') {
    return { __typename: event.__typename, sequence: event.sequence };
  }
  return {
    __typename: event.__typename,
    sequence: event.sequence,
    stateHash: event.stateHash,
    stateHashOrdered: event.stateHashOrdered ?? null,
  };
}

/**
 * Root-level queue event processor. Runs every incoming queue event through
 * the shared `queueReducer` — the exact reducer the board-route
 * `graphql-queue/QueueContext` uses — gated by the shared sync gate, so both
 * queue copies apply identical semantics (full state unification is a later
 * workstream). Deliberately does NOT pass a `myClientId` echo-suppression
 * hint to the action mapper: this copy is the server-authoritative mirror
 * and must apply every broadcast, including echoes of this client's own
 * mutations.
 */
export function useEventProcessor({
  syncGate,
  refs,
}: UseEventProcessorArgs): EventProcessorState & EventProcessorActions {
  const {
    lastReceivedSequenceRef,
    triggerResyncRef,
    queueEventSubscribersRef,
    sessionEventSubscribersRef,
    offlineBufferRef,
  } = refs;

  const queryClient = useQueryClient();

  const [reducerState, dispatchToReducer] = useReducer(
    queueReducer<QueueSearchParams>,
    undefined,
    (): QueueState<QueueSearchParams> => queueInitialState<QueueSearchParams>({}),
  );

  // Synchronous mirror of the reducer state. `handleQueueEvent` can run
  // several times in one task (the reconnect delta-replay loop feeds a whole
  // batch synchronously); React batches those dispatches, so the render
  // closure's `reducerState` goes stale mid-batch. The reorder pre-validation
  // below must read the state the reducer will actually see next, so the
  // wrapped dispatch replays each action against this mirror — the reducer is
  // pure, so replaying is deterministic and side-effect-free.
  const latestStateRef = useRef<QueueState<QueueSearchParams>>(queueInitialState<QueueSearchParams>({}));
  const dispatch = useCallback((action: QueueAction<QueueSearchParams>) => {
    latestStateRef.current = queueReducer(latestStateRef.current, action);
    dispatchToReducer(action);
  }, []);

  // Server hash mirror for React consumers (the watchdog effect re-arms on
  // it). The gate tracks the same value internally for its own comparisons;
  // this state updates at exactly the gate's tracking points.
  const [lastReceivedStateHash, setLastReceivedStateHash] = useState<string | null>(null);

  // Notify queue event subscribers
  const notifyQueueSubscribers = useCallback(
    (event: SubscriptionQueueEvent) => {
      queueEventSubscribersRef.current.forEach((callback) => callback(event));
    },
    [queueEventSubscribersRef],
  );

  // Notify session event subscribers
  const notifySessionSubscribers = useCallback(
    (event: SessionEvent) => {
      sessionEventSubscribersRef.current.forEach((callback) => callback(event));
    },
    [sessionEventSubscribersRef],
  );

  // Handle queue events internally
  const handleQueueEvent = useCallback(
    (event: SubscriptionQueueEvent) => {
      const gateEvent = toGateEvent(event);
      const decision = syncGate.evaluateIncoming(gateEvent);

      if (decision === 'ignore-stale') {
        const lastSequence = syncGate.getLastSequence();
        if (DEBUG) {
          console.info(
            `[PersistentSession] Ignoring stale/duplicate event with sequence ${gateEvent.sequence} ` +
              `(last received: ${lastSequence})`,
          );
        }
        // Mirrors mobile's QueueSyncStaleEventIgnored so both platforms report
        // to one event. This is the only instrument that can see the #3906
        // duplicate-sequence collision: unlike the interleaving that leaves a
        // `sequence > version` gap on the Postgres row, two writers landing on
        // the SAME sequence leave no server-side trace at all — the second
        // event just gets dropped here, silently.
        //
        // `staleness` is what separates a collision from ordinary lateness:
        //   'duplicate' — same sequence as the last applied event. Either a
        //     collision, or the controller path's deliberate co-sequenced
        //     FullSync + CurrentClimbChanged pair, which `eventType` tells
        //     apart.
        //   'behind'    — an older sequence, i.e. a redelivered frame after a
        //     reconnect. Expected, not a defect.
        track(SHARED_EVENTS.QueueSyncStaleEventIgnored, {
          eventType: event.__typename,
          sequence: gateEvent.sequence ?? null,
          lastSequence: lastSequence ?? null,
          staleness: gateEvent.sequence != null && gateEvent.sequence === lastSequence ? 'duplicate' : 'behind',
        });
        return;
      }

      if (decision === 'resync-gap') {
        console.warn(
          `[PersistentSession] Sequence gap detected: expected ${(syncGate.getLastSequence() ?? 0) + 1}, ` +
            `got ${gateEvent.sequence}. Triggering resync.`,
        );
        triggerResyncRef.current?.();
        return;
      }

      // decision === 'apply'. PlaybackStateChanged is ephemeral — the queue
      // reducer has no concept of playback frames, and the gate never
      // advances tracking for it (the server stamps it with the *current*
      // sequence, so tracking it would mark the next real delta stale).
      if (event.__typename !== 'PlaybackStateChanged') {
        let stateEvent: QueueStateEvent = event;

        if (stateEvent.__typename === 'FullSync') {
          // Merge offline-buffered items into the FullSync payload BEFORE
          // dispatch, for visual continuity during reconciliation — climbs
          // the user added while disconnected must not blink out of the queue
          // until `useOfflineReconciliation` pushes them to the server.
          // Server-sent nulls (corrupted items) are deliberately left in
          // place so the reducer's INITIAL_QUEUE_DATA filter can flag
          // `needsResync`.
          const pendingOfflineItems = offlineBufferRef.current;
          if (pendingOfflineItems.length > 0) {
            const serverUuids = new Set(stateEvent.state.queue.filter((item) => item != null).map((item) => item.uuid));
            const missingOfflineItems = pendingOfflineItems.filter((item) => !serverUuids.has(item.uuid));
            if (missingOfflineItems.length > 0) {
              stateEvent = {
                ...stateEvent,
                state: {
                  ...stateEvent.state,
                  queue: [
                    ...stateEvent.state.queue,
                    ...(missingOfflineItems as unknown as typeof stateEvent.state.queue),
                  ],
                },
              };
            }
          }
        }

        if (stateEvent.__typename === 'QueueReordered') {
          // Reorder pre-validation — a deliberate behavior change from the
          // old hand-rolled switch, which clamped out-of-range indices and
          // moved whatever item it found. If the item at oldIndex isn't the
          // item the server says it moved, local order has drifted from the
          // server's. Order drift is invisible to the sorted-uuid state hash,
          // so the 60s watchdog would never catch it and clamping could
          // diverge silently forever. Resync instead of dispatching.
          const itemAtOldIndex = latestStateRef.current.queue[stateEvent.oldIndex];
          if (itemAtOldIndex?.uuid !== stateEvent.uuid) {
            console.warn(
              `[PersistentSession] QueueReordered mismatch: expected item ${stateEvent.uuid} at index ` +
                `${stateEvent.oldIndex}, found ${itemAtOldIndex?.uuid ?? 'nothing'}. Triggering resync.`,
            );
            triggerResyncRef.current?.();
            return;
          }
        }

        const mappingResult = mapSubscriptionEnvelopeToAction(toWireEnvelope(stateEvent));
        if (mappingResult.kind === 'dispatch') {
          dispatch(mappingResult.action);
        } else {
          // Malformed payload (e.g. QueueItemAdded with no item). Skip the
          // dispatch but still advance sequence/hash tracking below — the
          // server did consume this sequence number.
          console.error(`[PersistentSession] Ignoring ${mappingResult.eventType} event: ${mappingResult.reason}`);
        }

        syncGate.noteApplied(gateEvent);
        // `use-offline-reconciliation` reads this ref to detect server-side
        // changes across a disconnect; the gate owns the value now.
        lastReceivedSequenceRef.current = syncGate.getLastSequence();
        setLastReceivedStateHash(gateEvent.stateHash ?? null);
      }

      // Notify external subscribers with the ORIGINAL event — the offline
      // reconciliation hook compares the unmerged server queue against its
      // buffer, so it must not see the offline items merged in above.
      notifyQueueSubscribers(event);
    },
    [syncGate, dispatch, triggerResyncRef, notifyQueueSubscribers, lastReceivedSequenceRef, offlineBufferRef],
  );

  const clearResyncFlag = useCallback(() => {
    dispatch({ type: 'CLEAR_RESYNC_FLAG' });
  }, [dispatch]);

  // Handle session events internally
  const handleSessionEvent = useCallback(
    (event: SessionEvent) => {
      if (event.__typename === 'SessionStatsUpdated') {
        const queryKey = SESSION_DETAIL_QUERY_KEY(event.sessionId);
        queryClient.setQueryData<SessionDetail | null>(queryKey, (prev) => {
          if (!prev) return prev;

          // Sort newest-first explicitly so firstTickAt/lastTickAt don't depend
          // on the server's arrival order. Compare epoch millis so mixed
          // timezone offsets (e.g. `+05:30` vs `Z`) still sort correctly.
          // The live stats event omits per-climb beta links (the subscription
          // doesn't select them), so carry over the ones the detail query
          // already cached, keyed by climb, rather than dropping them.
          // Key by `${boardType}:${climbUuid}` to match the session-detail
          // resolver's beta map, so a climb UUID shared across two boards keeps
          // its own beta.
          const betaByClimb = new Map(
            prev.ticks.map((tick) => [`${tick.boardType}:${tick.climbUuid}`, tick.betaLinks ?? []]),
          );
          const ticks = [...event.ticks]
            .sort((a, b) => new Date(b.climbedAt).getTime() - new Date(a.climbedAt).getTime())
            .map((tick) => ({ ...tick, betaLinks: betaByClimb.get(`${tick.boardType}:${tick.climbUuid}`) ?? [] }));
          const firstTickAt = ticks.length > 0 ? ticks[ticks.length - 1].climbedAt : prev.firstTickAt;
          const lastTickAt = ticks.length > 0 ? ticks[0].climbedAt : prev.lastTickAt;

          return {
            ...prev,
            participants: event.participants,
            totalSends: event.totalSends,
            totalFlashes: event.totalFlashes,
            totalAttempts: event.totalAttempts,
            tickCount: event.tickCount,
            gradeDistribution: event.gradeDistribution,
            boardTypes: event.boardTypes,
            hardestGrade: event.hardestGrade,
            durationMinutes: event.durationMinutes,
            goal: event.goal,
            ticks,
            firstTickAt,
            lastTickAt,
          };
        });
      }
      notifySessionSubscribers(event);
    },
    [queryClient, notifySessionSubscribers],
  );

  return {
    // TYPE SEAM: the reducer state's items use the shared @boardsesh/queue
    // ClimbQueueItem; the provider surface exposes the structurally-compatible
    // web ClimbQueueItem (see the seam note in queue-control/types.ts).
    queue: reducerState.queue as LocalClimbQueueItem[],
    currentClimbQueueItem: reducerState.currentClimbQueueItem as LocalClimbQueueItem | null,
    playlistSuggestionSource: reducerState.playlistSuggestionSource,
    pendingCurrentClimbUpdates: reducerState.pendingCurrentClimbUpdates,
    lastReceivedStateHash,
    needsResync: reducerState.needsResync,
    handleQueueEvent,
    handleSessionEvent,
    clearResyncFlag,
    notifyQueueSubscribers,
    notifySessionSubscribers,
    dispatch,
  };
}
