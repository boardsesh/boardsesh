import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { SubscriptionQueueEvent, SessionEvent, SessionLiveStats } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { evaluateQueueEventSequence, insertQueueItemIdempotent } from '../event-utils';
import type { SharedRefs } from '../types';
import { DEBUG } from '../types';

interface UseEventProcessorArgs {
  refs: Pick<SharedRefs,
    'lastReceivedSequenceRef' | 'triggerResyncRef' | 'lastCorruptionResyncRef' |
    'isFilteringCorruptedItemsRef' | 'queueEventSubscribersRef' | 'sessionEventSubscribersRef'
  >;
}

export interface EventProcessorState {
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  lastReceivedStateHash: string | null;
  serverStateHash: string | null;
  localStateHash: string | null;
  liveSessionStats: SessionLiveStats | null;
}

export interface EventProcessorActions {
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setQueueState: Dispatch<SetStateAction<LocalClimbQueueItem[]>>;
  setCurrentClimbQueueItem: Dispatch<SetStateAction<LocalClimbQueueItem | null>>;
  setLocalStateHash: Dispatch<SetStateAction<string | null>>;
  setServerStateHash: Dispatch<SetStateAction<string | null>>;
  shouldRefreshServerHashRef: MutableRefObject<boolean>;
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
  } = refs;

  const [queue, setQueueState] = useState<LocalClimbQueueItem[]>([]);
  const [currentClimbQueueItem, setCurrentClimbQueueItem] = useState<LocalClimbQueueItem | null>(null);
  const [serverStateHash, setServerStateHash] = useState<string | null>(null);
  const [localStateHash, setLocalStateHash] = useState<string | null>(null);
  const shouldRefreshServerHashRef = useRef(false);
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
        triggerResyncRef.current?.(true);
        return;
      }
    }

    switch (event.__typename) {
      case 'FullSync':
        setQueueState((event.state.queue as LocalClimbQueueItem[]).filter(item => item != null));
        setCurrentClimbQueueItem(event.state.currentClimbQueueItem as LocalClimbQueueItem | null);
        updateLastReceivedSequence(event.sequence);
        shouldRefreshServerHashRef.current = false;
        setServerStateHash(event.state.stateHash);
        break;
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
        shouldRefreshServerHashRef.current = true;
        break;
      case 'QueueItemRemoved':
        setQueueState((prev) => prev.filter((item) => item.uuid !== event.uuid));
        updateLastReceivedSequence(event.sequence);
        shouldRefreshServerHashRef.current = true;
        break;
      case 'QueueReordered':
        setQueueState((prev) => {
          if (event.oldIndex < 0 || event.oldIndex >= prev.length || event.newIndex < 0 || event.newIndex >= prev.length) {
            console.warn(
              `[PersistentSession] QueueReordered indices out of bounds: oldIndex=${event.oldIndex}, newIndex=${event.newIndex}, queue length=${prev.length}. Triggering resync.`
            );
            triggerResyncRef.current?.(true);
            return prev;
          }
          const newQueue = [...prev];
          const [item] = newQueue.splice(event.oldIndex, 1);
          newQueue.splice(event.newIndex, 0, item);
          return newQueue;
        });
        updateLastReceivedSequence(event.sequence);
        shouldRefreshServerHashRef.current = true;
        break;
      case 'CurrentClimbChanged':
        setCurrentClimbQueueItem(event.currentItem as LocalClimbQueueItem | null);
        updateLastReceivedSequence(event.sequence);
        shouldRefreshServerHashRef.current = true;
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
        shouldRefreshServerHashRef.current = true;
        break;
    }

    // Notify external subscribers
    notifyQueueSubscribers(event);
  }, [lastReceivedSequenceRef, triggerResyncRef, notifyQueueSubscribers, updateLastReceivedSequence]);

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
    lastReceivedStateHash: serverStateHash,
    serverStateHash,
    localStateHash,
    shouldRefreshServerHashRef,
    liveSessionStats,
    handleQueueEvent,
    handleSessionEvent,
    setQueueState,
    setCurrentClimbQueueItem,
    setLocalStateHash,
    setServerStateHash,
    setLiveSessionStats,
    notifyQueueSubscribers,
    notifySessionSubscribers,
  };
}
