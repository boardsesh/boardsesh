import { useEffect, useRef, type MutableRefObject } from 'react';
import type { SubscriptionQueueEvent, SessionUser } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '../../queue-control/types';

const RECONCILIATION_TIMEOUT_MS = 15000;

export interface UseOfflineReconciliationParams {
  offlineBuffer: {
    getBufferedAdditions: () => ClimbQueueItem[];
    clearBuffer: () => void;
    hasPendingAdditions: boolean;
    bufferAddition: (item: ClimbQueueItem) => void;
  };
  isDisconnected: boolean;
  isPersistentSessionActive: boolean;
  hasConnected: boolean;
  users: SessionUser[];
  lastReceivedSequenceRef: MutableRefObject<number | null>;
  persistentSession: {
    addQueueItem: (item: ClimbQueueItem) => Promise<void>;
    setQueue: (queue: ClimbQueueItem[], currentClimb?: ClimbQueueItem | null) => Promise<void>;
    setCurrentClimb: (item: ClimbQueueItem | null, shouldAddToQueue?: boolean, correlationId?: string) => Promise<void>;
    subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
  };
  currentQueue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
}

/**
 * Watches for disconnected-to-connected transitions and reconciles local queue
 * changes with the server.
 *
 * **Client-wins conditions** (full local state pushed to server):
 * - Only 1 user in the session (solo party session), OR
 * - Remote session hasn't changed while we were disconnected (same sequence number)
 *
 * **Server-wins with additions merge** (default):
 * - Server queue state is authoritative
 * - Only locally-added items are pushed to the server
 * - Removals, reorders, current-climb changes made while disconnected are discarded
 *
 * Note on timing: the FullSync event may arrive before this effect subscribes
 * (React effects are async). The 15-second safety timeout handles this case.
 * Since addQueueItem/setQueue are idempotent, the worst outcome is a redundant
 * server round-trip.
 */
export function useOfflineReconciliation({
  offlineBuffer,
  isDisconnected,
  isPersistentSessionActive,
  hasConnected,
  users,
  lastReceivedSequenceRef,
  persistentSession,
  currentQueue,
  currentClimbQueueItem,
}: UseOfflineReconciliationParams) {
  const wasDisconnectedRef = useRef(isDisconnected);
  const currentQueueRef = useRef(currentQueue);
  const currentClimbRef = useRef(currentClimbQueueItem);
  const usersRef = useRef(users);
  const sequenceAtDisconnectRef = useRef<number | null>(null);
  // Generation counter: incremented on each reconciliation attempt. Async
  // reconciliation functions check this to bail out if superseded by a newer attempt.
  const reconciliationGenerationRef = useRef(0);

  // Keep refs fresh
  currentQueueRef.current = currentQueue;
  currentClimbRef.current = currentClimbQueueItem;
  usersRef.current = users;

  // Capture the sequence number while disconnected so we can compare on reconnect.
  useEffect(() => {
    if (isDisconnected) {
      sequenceAtDisconnectRef.current = lastReceivedSequenceRef.current;
    }
  }, [isDisconnected, lastReceivedSequenceRef]);

  useEffect(() => {
    const wasDisconnected = wasDisconnectedRef.current;
    wasDisconnectedRef.current = isDisconnected;

    // Detect disconnected-to-connected transition
    if (!wasDisconnected || isDisconnected) return;
    if (!isPersistentSessionActive || !hasConnected) return;
    if (!offlineBuffer.hasPendingAdditions) return;

    const generation = ++reconciliationGenerationRef.current;

    /**
     * Determine whether the client's full local state should win.
     * Reads from refs to get the freshest values at FullSync time.
     */
    function shouldClientWin(serverSequence: number): boolean {
      const currentUsers = usersRef.current;
      // Solo session — no one else could have changed anything
      if (currentUsers.length <= 1) return true;
      // Server state unchanged since we went disconnected
      if (sequenceAtDisconnectRef.current !== null && serverSequence === sequenceAtDisconnectRef.current) return true;
      return false;
    }

    function isSuperseded() {
      return reconciliationGenerationRef.current !== generation;
    }

    async function reconcileClientWins() {
      const localQueue = currentQueueRef.current;
      const localCurrentClimb = currentClimbRef.current;
      try {
        if (isSuperseded()) return;
        await persistentSession.setQueue(localQueue, localCurrentClimb);
        if (localCurrentClimb && !isSuperseded()) {
          await persistentSession.setCurrentClimb(localCurrentClimb, false);
        }
      } catch (error) {
        console.error('[OfflineReconciliation] Failed to push full local state:', error);
      }
      if (!isSuperseded()) {
        offlineBuffer.clearBuffer();
      }
    }

    async function reconcileAdditionsOnly(serverQueue: ClimbQueueItem[]) {
      const pending = offlineBuffer.getBufferedAdditions();
      const serverUuids = new Set(serverQueue.map(item => item.uuid));

      for (const item of pending) {
        if (isSuperseded()) return;
        if (serverUuids.has(item.uuid)) continue;
        try {
          await persistentSession.addQueueItem(item);
        } catch (error) {
          console.error('[OfflineReconciliation] Failed to add buffered item:', item.climb?.name, error);
        }
      }

      if (!isSuperseded()) {
        offlineBuffer.clearBuffer();
      }
    }

    // Subscribe to queue events and wait for FullSync
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = persistentSession.subscribeToQueueEvents((event: SubscriptionQueueEvent) => {
      if (event.__typename === 'FullSync') {
        if (timeoutId) clearTimeout(timeoutId);
        unsubscribe();

        if (shouldClientWin(event.sequence)) {
          reconcileClientWins();
        } else {
          const serverQueue = (event.state?.queue ?? []) as ClimbQueueItem[];
          reconcileAdditionsOnly(serverQueue);
        }
      }
    });

    // Safety timeout: if no FullSync arrives, push additions using the server
    // queue from the FullSync that may have already been processed by the event
    // processor (which merges offline items). The UUID dedup means already-merged
    // items are skipped. This is a best-effort fallback.
    timeoutId = setTimeout(() => {
      unsubscribe();
      reconcileAdditionsOnly(currentQueueRef.current);
    }, RECONCILIATION_TIMEOUT_MS);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribe();
    };
  }, [isDisconnected, isPersistentSessionActive, hasConnected, offlineBuffer, persistentSession]);
}
