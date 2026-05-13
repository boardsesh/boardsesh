import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SubscriptionQueueEvent, SessionEvent, SessionDetail } from '@boardsesh/shared-schema';
import { computeQueueStateHash } from '@/app/utils/hash';
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

  // Keep `lastReceivedStateHash` aligned with the post-event local state once
  // the first FullSync has primed it. Delta events (QueueItemAdded, …) mutate
  // the queue but don't carry a server `stateHash`, so without this the 60s
  // hash watchdog in `use-session-subscriptions.ts` would flag every legitimate
  // delta as drift and spin into a resync loop against an outdated reference.
  useEffect(() => {
    if (lastReceivedStateHash === null) return;
    const expected = computeQueueStateHash(queue, currentClimbQueueItem?.uuid ?? null);
    if (expected !== lastReceivedStateHash) {
      setLastReceivedStateHash(expected);
    }
  }, [queue, currentClimbQueueItem, lastReceivedStateHash]);

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
      if (event.__typename !== 'FullSync') {
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
            updateLastReceivedSequence(event.sequence);
            break;
          }
          setQueueState((prev) => {
            return insertQueueItemIdempotent(prev, event.addedItem as LocalClimbQueueItem, event.position);
          });
          updateLastReceivedSequence(event.sequence);
          break;
        case 'QueueItemRemoved':
          setQueueState((prev) => prev.filter((item) => item.uuid !== event.uuid));
          updateLastReceivedSequence(event.sequence);
          break;
        case 'QueueReordered':
          setQueueState((prev) => {
            const newQueue = [...prev];
            const [item] = newQueue.splice(event.oldIndex, 1);
            newQueue.splice(event.newIndex, 0, item);
            return newQueue;
          });
          updateLastReceivedSequence(event.sequence);
          break;
        case 'CurrentClimbChanged':
          setCurrentClimbQueueItem(event.currentItem as LocalClimbQueueItem | null);
          updateLastReceivedSequence(event.sequence);
          break;
        case 'ClimbMirrored':
          setCurrentClimbQueueItem((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              climb: {
                ...prev.climb,
                mirrored: event.mirrored,
              },
            };
          });
          updateLastReceivedSequence(event.sequence);
          break;
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
          const ticks = [...event.ticks].sort(
            (a, b) => new Date(b.climbedAt).getTime() - new Date(a.climbedAt).getTime(),
          );
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
    notifyQueueSubscribers,
    notifySessionSubscribers,
  };
}
