import { useCallback, useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import type { SubscriptionQueueEvent, SessionEvent } from '@boardsesh/shared-schema';
import { RESYNC_LOOP_THRESHOLD, type QueueSyncGate } from '@boardsesh/queue-runtime';
import { computeQueueStateHash } from '@/app/utils/hash';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { type Session, type SharedRefs, DEBUG } from '../types';

type UseSessionSubscriptionsArgs = {
  session: Session | null;
  queue: LocalClimbQueueItem[];
  currentClimbQueueItem: LocalClimbQueueItem | null;
  lastReceivedStateHash: string | null;
  /** Reducer-detected corruption flag from the event processor. */
  needsResync: boolean;
  /** Acknowledge `needsResync` after acting on it. */
  clearResyncFlag: () => void;
  /**
   * Shared sync gate owned by `PersistentSessionProvider` (see
   * `use-event-processor.ts`). This hook consumes its hash-drift verdicts
   * (60s watchdog) and its corruption-resync cooldown; `useSessionLifecycle`
   * resets it on session change/disconnect.
   */
  syncGate: QueueSyncGate;
  refs: Pick<SharedRefs, 'triggerResyncRef' | 'queueEventSubscribersRef' | 'sessionEventSubscribersRef'>;
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
  needsResync,
  clearResyncFlag,
  syncGate,
  refs,
}: UseSessionSubscriptionsArgs): SessionSubscriptionsActions {
  const { triggerResyncRef, queueEventSubscribersRef, sessionEventSubscribersRef } = refs;

  // Corruption handling. Detection now lives in the shared reducer: when
  // INITIAL_QUEUE_DATA / UPDATE_QUEUE filters null (or climbless) items out
  // of an incoming payload it raises `needsResync`. Local state is already
  // clean post-dispatch (the reducer never stores nulls), so the old
  // setQueueState-based local re-filtering step is gone — this effect only
  // decides whether to pull authoritative server state, rate-limited by the
  // gate's cooldown so resync storms can't loop.
  useEffect(() => {
    if (!needsResync) return;
    // No session: leave the flag pending rather than acknowledging it with no
    // action — the next connect()'s FullSync overwrites `needsResync` anyway
    // (INITIAL_QUEUE_DATA recomputes it from the fresh payload).
    if (!session) return;
    clearResyncFlag();

    if (syncGate.evaluateCorruption() === 'cooldown') {
      console.error(
        '[PersistentSession] Reducer filtered corrupted queue items, but corruption resync is on cooldown. ' +
          'Keeping locally filtered state.',
      );
      return;
    }

    console.error('[PersistentSession] Reducer filtered corrupted queue items, triggering resync');
    triggerResyncRef.current?.();
  }, [needsResync, clearResyncFlag, session, syncGate, triggerResyncRef]);

  // Periodic state hash verification (every 60 seconds). The gate owns the
  // comparison, the consecutive-resync counting against an unchanging server
  // hash, and the 3-strike backoff (issue #2359); this effect owns the timer
  // and the Sentry report.
  useEffect(() => {
    if (!session || !lastReceivedStateHash || queue.length === 0) {
      return;
    }

    const verifyInterval = setInterval(() => {
      const localHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
      const { verdict, consecutiveResyncs, serverHash } = syncGate.verifyLocalHash(localHash);

      if (verdict === 'ok') {
        if (DEBUG) console.info('[PersistentSession] State hash verification passed');
        return;
      }

      console.warn(
        '[PersistentSession] State hash mismatch detected!',
        `Local: ${localHash}, Server: ${serverHash}`,
        'Triggering automatic resync...',
      );

      // Report exactly once per drift streak — the tick where the strike
      // count reaches the threshold (the same one-shot point the old
      // ref-based implementation reported at).
      if (consecutiveResyncs === RESYNC_LOOP_THRESHOLD) {
        console.error(
          `[PersistentSession] Resync loop detected: ${consecutiveResyncs} consecutive resyncs for server hash ${serverHash} (local hash ${localHash}). Capturing Sentry message.`,
        );
        Sentry.captureMessage('Resync loop: client keeps disagreeing with server hash', {
          level: 'warning',
          tags: { feature: 'party-session', issue: 'hash-resync-loop' },
          fingerprint: ['party-session', 'hash-resync-loop'],
          extra: {
            sessionId: session.id,
            serverHash,
            localHash,
            consecutiveResyncs,
            queueLength: queue.length,
            currentClimbUuid: currentClimbQueueItem?.uuid ?? null,
          },
        });
      }

      // 'backoff' verdict: repeated resyncs against an unchanging server
      // hash are no-ops on the server (issue #2359) — stop refiring every
      // minute. The gate resets its counter when the hashes agree again or
      // the server hash changes, so genuine new drift still resyncs.
      if (verdict === 'resync-drift') {
        triggerResyncRef.current?.();
      }
    }, 60000);

    return () => clearInterval(verifyInterval);
  }, [session, lastReceivedStateHash, queue, currentClimbQueueItem, syncGate, triggerResyncRef]);

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
