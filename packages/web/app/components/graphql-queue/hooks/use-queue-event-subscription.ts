import { type Dispatch, type RefObject, useEffect } from 'react';
import type { SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { mapSubscriptionEnvelopeToAction, type SubscriptionWireEnvelope } from '@boardsesh/queue-runtime';
import type { QueueAction } from '../../queue-control/types';
import { track } from '@/app/lib/analytics';

/**
 * Adapt the wire-format `SubscriptionQueueEvent` from `@boardsesh/shared-schema`
 * to the runtime's structural wire envelope. The two unions share field names
 * and `__typename` set; their `ClimbQueueItem` types come from different
 * packages so TS can't infer assignability directly, hence the cast. Web's
 * wire items already match `ClimbQueueItem` so no per-item lift is needed.
 */
function toWireEnvelope(event: SubscriptionQueueEvent): SubscriptionWireEnvelope<ClimbQueueItem> {
  return event as unknown as SubscriptionWireEnvelope<ClimbQueueItem>;
}

type UseQueueEventSubscriptionParams = {
  isPersistentSessionActive: boolean;
  dispatch: Dispatch<QueueAction>;
  persistentSession: {
    clientId: string | null;
    subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
    triggerResync: () => void;
  };
  needsResync: boolean;
  // Used to label peer-originated queue events with the local board layout.
  boardLayoutName?: string | null;
  // Read at event time so peer-broadcast events report the live queue length.
  // Passed as a ref (not a closure) so the subscription effect doesn't tear
  // down and re-subscribe on every render — a wrapper function would change
  // identity each render and re-arm the deps array, briefly leaving the
  // socket unsubscribed and dropping in-flight peer events.
  queueLengthRef?: RefObject<number>;
};

/**
 * Subscribes to queue events from the persistent session (party mode)
 * and dispatches delta actions to the reducer. Also handles resync
 * when corrupted data is detected.
 */
export function useQueueEventSubscription({
  isPersistentSessionActive,
  dispatch,
  persistentSession,
  needsResync,
  boardLayoutName,
  queueLengthRef,
}: UseQueueEventSubscriptionParams) {
  // Subscribe to queue events from persistent session
  useEffect(() => {
    if (!isPersistentSessionActive) return;

    const unsubscribe = persistentSession.subscribeToQueueEvents((event: SubscriptionQueueEvent) => {
      // Wire-format → reducer-action mapping lives in @boardsesh/queue-runtime
      // so web and mobile share one source of truth (incl. the echo-suppression
      // hints on DELTA_UPDATE_CURRENT_CLIMB). Analytics + side effects stay here.
      const result = mapSubscriptionEnvelopeToAction(toWireEnvelope(event), {
        context: { myClientId: persistentSession.clientId ?? undefined },
      });
      if (result.kind !== 'dispatch') return;
      dispatch(result.action as QueueAction);
      switch (result.eventType) {
        case 'QueueItemAdded':
          track('Climb Added to Queue', {
            boardLayout: boardLayoutName ?? null,
            addedFromTab: 'peer_broadcast',
            currentQueueLength: (queueLengthRef?.current ?? 0) + 1,
            partyMode: true,
          });
          break;
        case 'QueueItemRemoved':
          track('Climb Removed from Queue', {
            boardLayout: boardLayoutName ?? null,
            partyMode: true,
            removedBy: 'peer',
          });
          break;
      }
    });

    return unsubscribe;
  }, [isPersistentSessionActive, persistentSession, dispatch, boardLayoutName, queueLengthRef]);

  // Trigger resync when corrupted data is detected
  useEffect(() => {
    if (!needsResync || !isPersistentSessionActive) return;

    console.info('[QueueContext] Corrupted data detected, triggering resync');
    dispatch({ type: 'CLEAR_RESYNC_FLAG' });
    persistentSession.triggerResync();
  }, [needsResync, isPersistentSessionActive, persistentSession, dispatch]);
}
