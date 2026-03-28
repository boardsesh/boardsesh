import React, { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import type { SubscriptionQueueEvent, SessionEvent, SessionLiveStats } from '@boardsesh/shared-schema';
import { computeQueueStateHash } from '@/app/utils/hash';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { Session, ActiveSessionInfo, SharedRefs } from '../types';
import { CORRUPTION_RESYNC_COOLDOWN_MS, DEBUG } from '../types';

interface UseSessionSubscriptionsArgs {
  session: Session | null;
  activeSession: ActiveSessionInfo | null;
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  serverStateHash: string | null;
  localStateHash: string | null;
  shouldRefreshServerHashRef: React.MutableRefObject<boolean>;
  setLocalStateHash: Dispatch<SetStateAction<string | null>>;
  setServerStateHash: Dispatch<SetStateAction<string | null>>;
  liveSessionStats: { sessionId: string } | null;
  setQueueState: Dispatch<SetStateAction<LocalClimbQueueItem[]>>;
  setLiveSessionStats: Dispatch<SetStateAction<SessionLiveStats | null>>;
  refs: Pick<SharedRefs,
    'triggerResyncRef' | 'lastCorruptionResyncRef' | 'isFilteringCorruptedItemsRef' |
    'queueEventSubscribersRef' | 'sessionEventSubscribersRef'
  >;
}

export interface SessionSubscriptionsActions {
  subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
  subscribeToSessionEvents: (callback: (event: SessionEvent) => void) => () => void;
  triggerResync: () => void;
}

export function useSessionSubscriptions({
  session,
  activeSession,
  queue,
  currentClimbQueueItem,
  serverStateHash,
  localStateHash,
  shouldRefreshServerHashRef,
  setLocalStateHash,
  setServerStateHash,
  liveSessionStats,
  setQueueState,
  setLiveSessionStats,
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
    const hasCorruptedItems = queue.some(item => item == null);
    if (hasCorruptedItems) {
      const now = Date.now();
      const timeSinceLastResync = now - lastCorruptionResyncRef.current;

      if (timeSinceLastResync < CORRUPTION_RESYNC_COOLDOWN_MS) {
        console.error(
          `[PersistentSession] Detected null/undefined items in queue, but resync on cooldown ` +
          `(${Math.round((CORRUPTION_RESYNC_COOLDOWN_MS - timeSinceLastResync) / 1000)}s remaining). ` +
          `Filtering locally.`
        );
        isFilteringCorruptedItemsRef.current = true;
        setQueueState(prev => prev.filter(item => item != null));
        return;
      }

      console.error('[PersistentSession] Detected null/undefined items in queue, triggering resync');
      lastCorruptionResyncRef.current = now;
      triggerResyncRef.current?.(true);
      return;
    }

    // Compute local hash and conditionally update server hash
    const newHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
    setLocalStateHash(newHash);
    if (shouldRefreshServerHashRef.current) {
      shouldRefreshServerHashRef.current = false;
      setServerStateHash(newHash);
    }
  }, [session, queue, currentClimbQueueItem, setQueueState, setLocalStateHash, setServerStateHash, shouldRefreshServerHashRef, triggerResyncRef, lastCorruptionResyncRef, isFilteringCorruptedItemsRef]);

  // Periodic state hash verification (every 60 seconds)
  useEffect(() => {
    if (!session || !serverStateHash || queue.length === 0) {
      return;
    }

    const verifyInterval = setInterval(() => {
      const currentLocalHash = localStateHash ?? computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);

      if (currentLocalHash !== serverStateHash) {
        console.warn(
          '[PersistentSession] State hash mismatch detected!',
          `Local: ${currentLocalHash}, Server: ${serverStateHash}`,
          'Triggering automatic resync...'
        );
        triggerResyncRef.current?.(true);
      } else {
        if (DEBUG) console.log('[PersistentSession] State hash verification passed');
      }
    }, 60000);

    return () => clearInterval(verifyInterval);
  }, [session, serverStateHash, localStateHash, queue, currentClimbQueueItem, triggerResyncRef]);

  // Defensive state consistency check
  useEffect(() => {
    if (!session || !currentClimbQueueItem || queue.length === 0) {
      return;
    }

    const isCurrentInQueue = queue.some(item => item.uuid === currentClimbQueueItem.uuid);

    if (!isCurrentInQueue) {
      console.warn(
        '[PersistentSession] Current climb not found in queue - state inconsistency detected. Triggering resync.'
      );
      triggerResyncRef.current?.(true);
    }
  }, [session, currentClimbQueueItem, queue, triggerResyncRef]);

  // Reset live stats when active session changes or clears
  useEffect(() => {
    setLiveSessionStats((prev: SessionLiveStats | null) => {
      if (!activeSession) return null;
      return prev?.sessionId === activeSession.sessionId ? prev : null;
    });
  }, [activeSession, setLiveSessionStats]);

  // Event subscription functions
  const subscribeToQueueEvents = useCallback((callback: (event: SubscriptionQueueEvent) => void) => {
    queueEventSubscribersRef.current.add(callback);
    return () => {
      queueEventSubscribersRef.current.delete(callback);
    };
  }, [queueEventSubscribersRef]);

  const subscribeToSessionEvents = useCallback((callback: (event: SessionEvent) => void) => {
    sessionEventSubscribersRef.current.add(callback);
    return () => {
      sessionEventSubscribersRef.current.delete(callback);
    };
  }, [sessionEventSubscribersRef]);

  // Trigger a resync with the server
  const triggerResync = useCallback(() => {
    if (triggerResyncRef.current) {
      console.log('[PersistentSession] Manual resync triggered');
      triggerResyncRef.current();
    }
  }, [triggerResyncRef]);

  return {
    subscribeToQueueEvents,
    subscribeToSessionEvents,
    triggerResync,
  };
}
