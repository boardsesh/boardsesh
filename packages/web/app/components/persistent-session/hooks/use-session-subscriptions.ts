import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import * as Sentry from '@sentry/nextjs';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
import { computeQueueStateHash } from '@/app/utils/hash';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { type Session, type SharedRefs, CORRUPTION_RESYNC_COOLDOWN_MS, DEBUG } from '../types';

// When the 60s hash watchdog triggers resync for the *same* server hash this
// many times in a row, the underlying drift isn't getting fixed — the client
// and server agree on the hash but the client's local computation keeps
// disagreeing with itself. Surface it to Sentry so we have something to
// investigate instead of an invisible per-minute resync loop.
const RESYNC_LOOP_THRESHOLD = 3;

type UseSessionSubscriptionsArgs = {
  session: Session | null;
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
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
  const lastResyncHashRef = useRef<string | null>(null);
  const consecutiveResyncCountRef = useRef(0);
  const sentryReportedHashRef = useRef<string | null>(null);

  // Reset the resync-loop trackers whenever the active session changes.
  // Otherwise a hash that triggered N resyncs in session A would carry
  // forward into session B and either over-count or suppress the Sentry
  // breadcrumb that should fire fresh per session.
  const sessionIdForReset = session?.id ?? null;
  useEffect(() => {
    lastResyncHashRef.current = null;
    consecutiveResyncCountRef.current = 0;
    sentryReportedHashRef.current = null;
  }, [sessionIdForReset]);

  useEffect(() => {
    if (!session || !lastReceivedStateHash || queue.length === 0) {
      return;
    }

    const verifyInterval = setInterval(() => {
      const localHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);

      if (localHash !== lastReceivedStateHash) {
        console.warn(
          '[PersistentSession] State hash mismatch detected!',
          `Local: ${localHash}, Server: ${lastReceivedStateHash}`,
          'Triggering automatic resync...',
        );

        if (lastResyncHashRef.current === lastReceivedStateHash) {
          consecutiveResyncCountRef.current += 1;
        } else {
          lastResyncHashRef.current = lastReceivedStateHash;
          consecutiveResyncCountRef.current = 1;
          sentryReportedHashRef.current = null;
        }

        if (
          consecutiveResyncCountRef.current >= RESYNC_LOOP_THRESHOLD &&
          sentryReportedHashRef.current !== lastReceivedStateHash
        ) {
          sentryReportedHashRef.current = lastReceivedStateHash;
          console.error(
            `[PersistentSession] Resync loop detected: ${consecutiveResyncCountRef.current} consecutive resyncs for server hash ${lastReceivedStateHash} (local hash ${localHash}). Capturing Sentry message.`,
          );
          Sentry.captureMessage('Resync loop: client keeps disagreeing with server hash', {
            level: 'warning',
            tags: { feature: 'party-session', issue: 'hash-resync-loop' },
            fingerprint: ['party-session', 'hash-resync-loop'],
            extra: {
              sessionId: session.id,
              serverHash: lastReceivedStateHash,
              localHash,
              consecutiveResyncs: consecutiveResyncCountRef.current,
              queueLength: queue.length,
              currentClimbUuid: currentClimbQueueItem?.uuid ?? null,
            },
          });
        }

        // Stop auto-resyncing once we've hit the loop threshold for this exact
        // server hash. Repeated resyncs against an unchanging server hash are
        // no-ops on the server (issue #2359) — the resync isn't fixing the
        // disagreement, so refiring every minute just spams the session. Keep
        // the Sentry alert above, but back off here. The counter resets when
        // the hashes finally agree or the server hash changes, so genuine new
        // drift still resyncs.
        if (consecutiveResyncCountRef.current <= RESYNC_LOOP_THRESHOLD && triggerResyncRef.current) {
          triggerResyncRef.current();
        }
      } else {
        // Hash matches — reset the loop counter so future drift starts fresh.
        consecutiveResyncCountRef.current = 0;
        lastResyncHashRef.current = null;
        sentryReportedHashRef.current = null;
        if (DEBUG) console.info('[PersistentSession] State hash verification passed');
      }
    }, 60000);

    return () => clearInterval(verifyInterval);
  }, [session, lastReceivedStateHash, queue, currentClimbQueueItem, triggerResyncRef]);

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
