import { useEffect, useRef, type RefObject } from 'react';
import type { SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import { track } from '@/app/lib/analytics';

type UsePeerBroadcastAnalyticsParams = {
  subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
  /**
   * True when the current route is a board route. Read via a ref internally
   * (mirrored every render) so the subscription effect below doesn't tear
   * down and re-subscribe on every route change.
   */
  isOnBoardRoute: boolean;
  boardLayoutName: string | null;
  /**
   * The live queue array, read (via `.length`) at event time so
   * peer-broadcast events report the current queue length. Passed as a ref
   * (not a closure/number prop) so the subscription effect below doesn't
   * tear down and re-subscribe on every queue change — `persistent-session-context.tsx`
   * already mirrors `eventProcessor.queue` into a ref every render for
   * exactly this purpose (`queueRef`).
   */
  queueRef: RefObject<{ length: number }>;
  /**
   * This client's joinSession-returned connection id (`lifecycle.session.clientId`),
   * or null when not in a session. Used to suppress self-echoes of our own
   * removes. Read via a ref internally so a rejoin doesn't tear down the
   * subscription effect.
   */
  clientId: string | null;
};

/**
 * Peer-broadcast queue-add/-remove analytics.
 *
 * Moved from the deleted board-route hook `graphql-queue/hooks/use-queue-event-subscription.ts`
 * (W6: board routes read root queue state directly instead of mirroring
 * events through their own subscription, so that hook's job — dispatching a
 * mirrored copy of the action — no longer exists; only its analytics
 * side-effect survives, relocated here to the root).
 *
 * `isOnBoardRoute` is the one behavior difference this relocation has to
 * restate explicitly: the old hook only ever ran inside `GraphQLQueueProvider`,
 * which only mounts on board routes, so off-board surfaces never fired this
 * analytics. The root persistent-session provider is always mounted (on AND
 * off board routes) — without this gate, the same analytics would start
 * firing off-board too, a parity regression.
 *
 * Fires on every `QueueItemAdded`/`QueueItemRemoved` event this client's
 * queue subscription receives. `QueueItemRemoved` now carries the removing
 * client's connection id (#3382), so echoes of our OWN removes are skipped —
 * the local remove already tracked itself with `removedBy: 'self'` in
 * `graphql-queue/QueueContext.tsx`, and tracking the echo double counted.
 * `QueueItemAdded` still has no clientId on the wire, so self-adds remain
 * double counted — tracked as a follow-up in #4042.
 */
export function usePeerBroadcastAnalytics({
  subscribeToQueueEvents,
  isOnBoardRoute,
  boardLayoutName,
  queueRef,
  clientId,
}: UsePeerBroadcastAnalyticsParams) {
  const isOnBoardRouteRef = useRef(isOnBoardRoute);
  isOnBoardRouteRef.current = isOnBoardRoute;
  const boardLayoutNameRef = useRef(boardLayoutName);
  boardLayoutNameRef.current = boardLayoutName;
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;

  useEffect(() => {
    const unsubscribe = subscribeToQueueEvents((event: SubscriptionQueueEvent) => {
      if (!isOnBoardRouteRef.current) return;
      if (event.__typename === 'QueueItemAdded') {
        // Malformed payload (no item): the reducer skips these (the wire
        // mapper returns kind 'ignore'), and the old hook gated analytics on
        // that dispatch actually happening. Keep the parity — no state
        // change, no analytics.
        if (!event.addedItem) return;
        track('Climb Added to Queue', {
          boardLayout: boardLayoutNameRef.current,
          addedFromTab: 'peer_broadcast',
          currentQueueLength: (queueRef.current?.length ?? 0) + 1,
          partyMode: true,
        });
      } else if (event.__typename === 'QueueItemRemoved') {
        // Echo of our own remove: `graphql-queue/QueueContext.tsx` already
        // tracked it with `removedBy: 'self'`, so tracking again would double
        // count. Both truthiness guards matter — a solo/unjoined client has no
        // clientId, and a pre-#3382 server sends none, so either way we fall
        // back to the historical 'peer' attribution.
        if (event.clientId && clientIdRef.current && event.clientId === clientIdRef.current) return;
        track('Climb Removed from Queue', {
          boardLayout: boardLayoutNameRef.current,
          partyMode: true,
          removedBy: 'peer',
        });
      }
    });
    return unsubscribe;
  }, [subscribeToQueueEvents, queueRef]);
}
