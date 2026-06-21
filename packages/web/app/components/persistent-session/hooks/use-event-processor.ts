import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SubscriptionQueueEvent, SessionEvent, SessionDetail } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { evaluateQueueEventSequence, insertQueueItemIdempotent } from '../event-utils';
import { type SharedRefs, DEBUG } from '../types';
import { SESSION_DETAIL_QUERY_KEY } from '@/app/hooks/use-session-detail';

type UseEventProcessorArgs = {
  refs: Pick<
    SharedRefs,
    | 'lastReceivedSequenceRef'
    | 'triggerResyncRef'
    | 'lastCorruptionResyncRef'
    | 'isFilteringCorruptedItemsRef'
    | 'queueEventSubscribersRef'
    | 'sessionEventSubscribersRef'
    | 'offlineBufferRef'
  >;
};

export type EventProcessorState = {
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  lastReceivedStateHash: string | null;
};

export type EventProcessorActions = {
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setQueueState: Dispatch<SetStateAction<LocalClimbQueueItem[]>>;
  setCurrentClimbQueueItem: Dispatch<SetStateAction<LocalClimbQueueItem | null>>;
  setLastReceivedStateHash: Dispatch<SetStateAction<string | null>>;
  notifyQueueSubscribers: (event: SubscriptionQueueEvent) => void;
  notifySessionSubscribers: (event: SessionEvent) => void;
};

export function useEventProcessor({ refs }: UseEventProcessorArgs): EventProcessorState & EventProcessorActions {
  const {
    lastReceivedSequenceRef,
    triggerResyncRef,
    lastCorruptionResyncRef: _lastCorruptionResyncRef,
    isFilteringCorruptedItemsRef: _isFilteringCorruptedItemsRef,
    queueEventSubscribersRef,
    sessionEventSubscribersRef,
    offlineBufferRef,
  } = refs;

  const queryClient = useQueryClient();

  const [queue, setQueueState] = useState<LocalClimbQueueItem[]>([]);
  const [currentClimbQueueItem, setCurrentClimbQueueItem] = useState<LocalClimbQueueItem | null>(null);
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

  // Helper to update sequence ref
  const updateLastReceivedSequence = useCallback(
    (sequence: number) => {
      lastReceivedSequenceRef.current = sequence;
    },
    [lastReceivedSequenceRef],
  );

  // Handle queue events internally
  const handleQueueEvent = useCallback(
    (event: SubscriptionQueueEvent) => {
      // Sequence validation for stale/gap detection (use ref to avoid stale closure).
      // FullSync always resets local state and sequence tracking.
      //
      // PlaybackStateChanged is also exempt: the server stamps it with the
      // *current* sequence number (it doesn't mutate the queue, so the room
      // manager doesn't bump). Routing it through the dedup gate would mark
      // every event after the first as stale and silently drop party-mode
      // playback sync. The post-switch block below already skips updating
      // `lastReceivedSequence`/`stateHash` for this event type.
      if (event.__typename !== 'FullSync' && event.__typename !== 'PlaybackStateChanged') {
        const lastSeq = lastReceivedSequenceRef.current;
        const sequenceDecision = evaluateQueueEventSequence(lastSeq, event.sequence);

        if (sequenceDecision === 'ignore-stale') {
          if (DEBUG) {
            console.info(
              `[PersistentSession] Ignoring stale/duplicate event with sequence ${event.sequence} ` +
                `(last received: ${lastSeq})`,
            );
          }
          return;
        }

        if (sequenceDecision === 'gap') {
          console.warn(
            `[PersistentSession] Sequence gap detected: expected ${lastSeq! + 1}, got ${event.sequence}. ` +
              `Triggering resync.`,
          );
          if (triggerResyncRef.current) {
            triggerResyncRef.current();
          }
          return;
        }
      }

      switch (event.__typename) {
        case 'FullSync': {
          const serverQueue = (event.state.queue as LocalClimbQueueItem[]).filter((item) => item != null);
          // Merge offline-buffered items for visual continuity during reconciliation
          const pending = offlineBufferRef.current;
          if (pending.length > 0) {
            const serverUuids = new Set(serverQueue.map((item) => item.uuid));
            for (const item of pending) {
              if (!serverUuids.has(item.uuid)) {
                serverQueue.push(item);
              }
            }
          }
          setQueueState(serverQueue);
          setCurrentClimbQueueItem(event.state.currentClimbQueueItem as LocalClimbQueueItem | null);
          updateLastReceivedSequence(event.sequence);
          setLastReceivedStateHash(event.state.stateHash);
          break;
        }
        case 'QueueItemAdded':
          if (event.addedItem == null) {
            console.error('[PersistentSession] Received QueueItemAdded with null/undefined item, skipping');
            break;
          }
          setQueueState((prev) => {
            return insertQueueItemIdempotent(prev, event.addedItem as LocalClimbQueueItem, event.position ?? undefined);
          });
          break;
        case 'QueueItemRemoved':
          setQueueState((prev) => prev.filter((item) => item.uuid !== event.uuid));
          setCurrentClimbQueueItem((prev) => (prev?.uuid === event.uuid ? null : prev));
          break;
        case 'QueueReordered':
          setQueueState((prev) => {
            const sourceIndex = prev.findIndex((item) => item.uuid === event.uuid);
            const oldIndex = sourceIndex >= 0 ? sourceIndex : event.oldIndex;
            if (oldIndex < 0 || oldIndex >= prev.length) {
              console.warn(
                `[PersistentSession] Received QueueReordered for missing item ${event.uuid}; waiting for hash watchdog resync`,
              );
              return prev;
            }
            const newQueue = [...prev];
            const [item] = newQueue.splice(oldIndex, 1);
            const newIndex = Math.max(0, Math.min(event.newIndex, newQueue.length));
            newQueue.splice(newIndex, 0, item);
            return newQueue;
          });
          break;
        case 'CurrentClimbChanged':
          setCurrentClimbQueueItem(event.currentItem as LocalClimbQueueItem | null);
          break;
        case 'ClimbMirrored':
          if (event.mirroredUuid) {
            setQueueState((prev) =>
              prev.map((item) =>
                item.uuid === event.mirroredUuid
                  ? {
                      ...item,
                      climb: {
                        ...item.climb,
                        mirrored: event.mirrored,
                      },
                    }
                  : item,
              ),
            );
          }
          setCurrentClimbQueueItem((prev) => {
            if (!prev) return prev;
            if (event.mirroredUuid && prev.uuid !== event.mirroredUuid) return prev;
            return {
              ...prev,
              climb: {
                ...prev.climb,
                mirrored: event.mirrored,
              },
            };
          });
          break;
      }

      if (event.__typename !== 'FullSync' && event.__typename !== 'PlaybackStateChanged') {
        // PlaybackStateChanged is ephemeral — it doesn't carry a stateHash
        // because it doesn't mutate the queue. The room manager reuses the
        // current sequence number for ordering, so skip both updates here
        // to avoid clobbering the watchdog's drift detection with a stale
        // sequence repeat.
        updateLastReceivedSequence(event.sequence);
        setLastReceivedStateHash(event.stateHash);
      }

      // Notify external subscribers
      notifyQueueSubscribers(event);
    },
    [lastReceivedSequenceRef, triggerResyncRef, notifyQueueSubscribers, updateLastReceivedSequence, offlineBufferRef],
  );

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
    queue,
    currentClimbQueueItem,
    lastReceivedStateHash,
    handleQueueEvent,
    handleSessionEvent,
    setQueueState,
    setCurrentClimbQueueItem,
    setLastReceivedStateHash,
    notifyQueueSubscribers,
    notifySessionSubscribers,
  };
}
