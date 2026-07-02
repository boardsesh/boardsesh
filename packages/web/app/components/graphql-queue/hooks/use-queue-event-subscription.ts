import { type Dispatch, type RefObject, useEffect } from 'react';
import type { SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import { mapSubscriptionEnvelopeToAction } from '@boardsesh/queue-runtime';
import { toWireEnvelope } from '../../persistent-session/event-utils';
import type { QueueAction } from '../../queue-control/types';
import { track } from '@/app/lib/analytics';

// `toWireEnvelope` (and its `QueueStateEvent` input type) moved to
// `persistent-session/event-utils.ts` so the root persistent-session event
// processor can share it. Re-export for this hook's existing importers; a
// later workstream deletes this hook entirely.
export { toWireEnvelope, toSyncQueueEvent } from '../../persistent-session/event-utils';
export type { QueueStateEvent } from '../../persistent-session/event-utils';

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
      // PlaybackStateChanged is ephemeral — `use-drawer-playback` subscribes
      // to the same stream and handles it. The queue reducer has no concept
      // of playback frames, so skip the runtime mapper entirely.
      if (event.__typename === 'PlaybackStateChanged') return;
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
