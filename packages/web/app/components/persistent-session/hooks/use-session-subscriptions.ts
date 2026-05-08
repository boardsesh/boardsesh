import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
import { computeQueueStateHash } from '@/app/utils/hash';
import type { ClimbQueueItem as LocalClimbQueueItem, UserPick } from '../../queue-control/types';
import { type Session, type SharedRefs, CORRUPTION_RESYNC_COOLDOWN_MS, DEBUG } from '../types';

type UseSessionSubscriptionsArgs = {
  session: Session | null;
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  picks: UserPick[];
  activeClimberUserId: string | null;
  lastReceivedStateHash: string | null;
  setQueueState: Dispatch<SetStateAction<LocalClimbQueueItem[]>>;
  refs: Pick<
    SharedRefs,
    | 'triggerResyncRef'
    | 'lastCorruptionResyncRef'
    | 'isFilteringCorruptedItemsRef'
    | 'queueEventSubscribersRef'
    | 'sessionEventSubscribersRef'
  >;
};

export type SessionSubscriptionsActions = {
  subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
  subscribeToSessionEvents: (callback: (event: SessionEvent) => void) => () => void;
  triggerResync: () => void;
};

export function useSessionSubscriptions({
  session,
  queue,
  currentClimbQueueItem,
  picks,
  activeClimberUserId,
  lastReceivedStateHash,
  setQueueState,
  refs,
}: UseSessionSubscriptionsArgs): SessionSubscriptionsActions {
  const {
    triggerResyncRef,
    lastCorruptionResyncRef,
    isFilteringCorruptedItemsRef,
    queueEventSubscribersRef,
    sessionEventSubscribersRef,
  } = refs;

  // Keep state hash in sync with local state after delta events
  // Also detects corrupted items and triggers resync if found
  useEffect(() => {
    if (!session) return;

    if (isFilteringCorruptedItemsRef.current) {
      isFilteringCorruptedItemsRef.current = false;
      return;
    }

    // Check for corrupted (null/undefined) items in the queue
    const hasCorruptedItems = queue.some((item) => item == null);
    if (hasCorruptedItems) {
      const now = Date.now();
      const timeSinceLastResync = now - lastCorruptionResyncRef.current;

      if (timeSinceLastResync < CORRUPTION_RESYNC_COOLDOWN_MS) {
        console.error(
          `[PersistentSession] Detected null/undefined items in queue, but resync on cooldown ` +
            `(${Math.round((CORRUPTION_RESYNC_COOLDOWN_MS - timeSinceLastResync) / 1000)}s remaining). ` +
            `Filtering locally.`,
        );
        isFilteringCorruptedItemsRef.current = true;
        setQueueState((prev) => prev.filter((item) => item != null));
        return;
      }

      console.error('[PersistentSession] Detected null/undefined items in queue, triggering resync');
      lastCorruptionResyncRef.current = now;
      if (triggerResyncRef.current) {
        triggerResyncRef.current();
      }
      return;
    }
    // Note: hash is computed in the main provider via the event processor
  }, [
    session,
    queue,
    currentClimbQueueItem,
    setQueueState,
    triggerResyncRef,
    lastCorruptionResyncRef,
    isFilteringCorruptedItemsRef,
  ]);

  // Periodic state hash verification (every 60 seconds)
  useEffect(() => {
    if (!session || !lastReceivedStateHash || queue.length === 0) {
      return;
    }

    const verifyInterval = setInterval(() => {
      const localHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null, picks, activeClimberUserId);

      if (localHash !== lastReceivedStateHash) {
        console.warn(
          '[PersistentSession] State hash mismatch detected!',
          `Local: ${localHash}, Server: ${lastReceivedStateHash}`,
          'Triggering automatic resync...',
        );
        if (triggerResyncRef.current) {
          triggerResyncRef.current();
        }
      } else {
        if (DEBUG) console.info('[PersistentSession] State hash verification passed');
      }
    }, 60000);

    return () => clearInterval(verifyInterval);
  }, [session, lastReceivedStateHash, queue, currentClimbQueueItem, picks, activeClimberUserId, triggerResyncRef]);

  // Defensive state consistency check
  useEffect(() => {
    if (!session || !currentClimbQueueItem || queue.length === 0) {
      return;
    }

    const isCurrentInQueue = queue.some((item) => item.uuid === currentClimbQueueItem.uuid);

    if (!isCurrentInQueue) {
      console.warn(
        '[PersistentSession] Current climb not found in queue - state inconsistency detected. Triggering resync.',
      );
      if (triggerResyncRef.current) {
        triggerResyncRef.current();
      }
    }
  }, [session, currentClimbQueueItem, queue, triggerResyncRef]);

  // Event subscription functions
  const subscribeToQueueEvents = useCallback(
    (callback: (event: SubscriptionQueueEvent) => void) => {
      queueEventSubscribersRef.current.add(callback);
      return () => {
        queueEventSubscribersRef.current.delete(callback);
      };
    },
    [queueEventSubscribersRef],
  );

  const subscribeToSessionEvents = useCallback(
    (callback: (event: SessionEvent) => void) => {
      sessionEventSubscribersRef.current.add(callback);
      return () => {
        sessionEventSubscribersRef.current.delete(callback);
      };
    },
    [sessionEventSubscribersRef],
  );

  // Trigger a resync with the server
  const triggerResync = useCallback(() => {
    if (triggerResyncRef.current) {
      console.info('[PersistentSession] Manual resync triggered');
      triggerResyncRef.current();
    }
  }, [triggerResyncRef]);

  return {
    subscribeToQueueEvents,
    subscribeToSessionEvents,
    triggerResync,
  };
}
