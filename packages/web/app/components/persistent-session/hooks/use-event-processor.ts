import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { SubscriptionQueueEvent, SessionEvent, SessionLiveStats } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { evaluateQueueEventSequence, insertQueueItemIdempotent } from '../event-utils';
import type { SharedRefs } from '../types';
import { DEBUG } from '../types';

interface UseEventProcessorArgs {
  refs: Pick<SharedRefs,
    'lastReceivedSequenceRef' | 'triggerResyncRef' | 'lastCorruptionResyncRef' |
    'isFilteringCorruptedItemsRef' | 'queueEventSubscribersRef' | 'sessionEventSubscribersRef' |
    'offlineBufferRef'
  >;
}

export interface EventProcessorState {
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  lastReceivedStateHash: string | null;
  liveSessionStats: SessionLiveStats | null;
}

export interface EventProcessorActions {
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setQueueState: Dispatch<SetStateAction<LocalClimbQueueItem[]>>;
  setCurrentClimbQueueItem: Dispatch<SetStateAction<LocalClimbQueueItem | null>>;
  setLiveSessionStats: Dispatch<SetStateAction<SessionLiveStats | null>>;
  notifyQueueSubscribers: (event: SubscriptionQueueEvent) => void;
  notifySessionSubscribers: (event: SessionEvent) => void;
}

export function useEventProcessor({ refs }: UseEventProcessorArgs): EventProcessorState & EventProcessorActions {
  const {
    lastReceivedSequenceRef,
    triggerResyncRef,
    lastCorruptionResyncRef,
    isFilteringCorruptedItemsRef,
    queueEventSubscribersRef,
    sessionEventSubscribersRef,
    offlineBufferRef,
  } = refs;

  const [queue, setQueueState] = useState<LocalClimbQueueItem[]>([]);
  const [currentClimbQueueItem, setCurrentClimbQueueItem] = useState<LocalClimbQueueItem | null>(null);
  const [lastReceivedStateHash, setLastReceivedStateHash] = useState<string | null>(null);
  const [liveSessionStats, setLiveSessionStats] = useState<SessionLiveStats | null>(null);

  // Notify queue event subscribers
  const notifyQueueSubscribers = useCallback((event: SubscriptionQueueEvent) => {
    queueEventSubscribersRef.current.forEach((callback) => callback(event));
  }, [queueEventSubscribersRef]);

  // Notify session event subscribers
  const notifySessionSubscribers = useCallback((event: SessionEvent) => {
    sessionEventSubscribersRef.current.forEach((callback) => callback(event));
  }, [sessionEventSubscribersRef]);

  // Helper to update sequence ref
  const updateLastReceivedSequence = useCallback((sequence: number) => {
    lastReceivedSequenceRef.current = sequence;
  }, [lastReceivedSequenceRef]);

  // Handle queue events internally
  const handleQueueEvent = useCallback((event: SubscriptionQueueEvent) => {
    // Sequence validation for stale/gap detection (use ref to avoid stale closure).
    // FullSync always resets local state and sequence tracking.
    if (event.__typename !== 'FullSync') {
      const lastSeq = lastReceivedSequenceRef.current;
      const sequenceDecision = evaluateQueueEventSequence(lastSeq, event.sequence);

      if (sequenceDecision === 'ignore-stale') {
        if (DEBUG) {
          console.log(
            `[PersistentSession] Ignoring stale/duplicate event with sequence ${event.sequence} ` +
            `(last received: ${lastSeq})`
          );
        }
        return;
      }

      if (sequenceDecision === 'gap') {
        console.warn(
          `[PersistentSession] Sequence gap detected: expected ${lastSeq! + 1}, got ${event.sequence}. ` +
          `Triggering resync.`
        );
        if (triggerResyncRef.current) {
          triggerResyncRef.current();
        }
        return;
      }
    }

    switch (event.__typename) {
      case 'FullSync': {
        const serverQueue = (event.state.queue as LocalClimbQueueItem[]).filter(item => item != null);
        // Merge offline-buffered items for visual continuity during reconciliation
        const pending = offlineBufferRef.current;
        if (pending.length > 0) {
          const serverUuids = new Set(serverQueue.map(item => item.uuid));
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
          return insertQueueItemIdempotent(
            prev,
            event.addedItem as LocalClimbQueueItem,
            event.position,
          );
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
  }, [lastReceivedSequenceRef, triggerResyncRef, notifyQueueSubscribers, updateLastReceivedSequence, offlineBufferRef]);

  // Handle session events internally
  const handleSessionEvent = useCallback((event: SessionEvent) => {
    // This is handled externally by the session lifecycle hook via setSession
    // We only handle stats updates here and forward to subscribers
    if (event.__typename === 'SessionStatsUpdated') {
      setLiveSessionStats({
        sessionId: event.sessionId,
        totalSends: event.totalSends,
        totalFlashes: event.totalFlashes,
        totalAttempts: event.totalAttempts,
        tickCount: event.tickCount,
        participants: event.participants,
        gradeDistribution: event.gradeDistribution,
        boardTypes: event.boardTypes,
        hardestGrade: event.hardestGrade,
        durationMinutes: event.durationMinutes,
        goal: event.goal,
        ticks: event.ticks,
      });
    }
    notifySessionSubscribers(event);
  }, [notifySessionSubscribers]);

  return {
    queue,
    currentClimbQueueItem,
    lastReceivedStateHash,
    liveSessionStats,
    handleQueueEvent,
    handleSessionEvent,
    setQueueState,
    setCurrentClimbQueueItem,
    setLiveSessionStats,
    notifyQueueSubscribers,
    notifySessionSubscribers,
  };
}
