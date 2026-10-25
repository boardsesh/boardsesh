// The layout-wide live climb-stats stream behind the board adapter's
// `subscribeClimbStats`, multiplexed over the singleton graphql-ws client.

import type { ClimbStatsSubscriptionHandlers } from '@boardsesh/board-react';
import type { Client } from '@boardsesh/graphql-client';
import {
  CLIMB_STATS_UPDATED_SUBSCRIPTION,
  type ClimbStatsUpdatedSubscriptionResponse,
} from '@boardsesh/graphql/operations';
import { getConnectivitySnapshot, subscribeConnectivity } from '../connectivity/connectivity-store';
import { getWsClient } from '../graphql/ws-client';
import { subscribeWsClientDisposed } from '../graphql/ws-client-lifecycle';

/**
 * Subscribe to live stats for one layout, and keep the stream on whichever
 * client `getWsClient()` hands out.
 *
 * The client is read on every (re)subscribe, never once per stream. Offline
 * mode disposes the cached client, and graphql-ws never reconnects a disposed
 * client, yet it still opens a new socket for each new operation on it. A
 * stream that kept its first client re-subscribed on the dead one after
 * Offline mode off, and that socket stayed open through the next Offline mode
 * on, because the next dispose only closes the newer cached client (#6766).
 */
export function subscribeClimbStatsStream(
  boardType: string,
  layoutId: number,
  handlers: ClimbStatsSubscriptionHandlers,
): () => void {
  let disposed = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeStats: (() => void) | null = null;
  let boundClient: Client | null = null;
  let unbindConnected: (() => void) | null = null;
  // graphql-ws calls `complete` asynchronously after a release. Without this
  // a late callback from the released stream would null out the new stream's
  // `unsubscribeStats` and schedule a second retry. Both a release and a new
  // subscribe bump it, so a release-then-resubscribe bumps it twice; only
  // "each stream sees a different number" matters.
  let subscriptionGeneration = 0;
  // Live stats need a reachable backend. While the connectivity store
  // says we're effectively offline, a (re)subscribe can only fail, and
  // the exponential ladder below would keep waking the socket against a
  // server we know is down (#4862). Park it on this flag instead and let
  // the store's edge back to reachable restart it.
  let deferredForConnectivity = false;

  const releaseBoundClient = () => {
    subscriptionGeneration += 1;
    unsubscribeStats?.();
    unsubscribeStats = null;
    unbindConnected?.();
    unbindConnected = null;
    boundClient = null;
  };

  // The catch-up refresh on reconnect must follow the client too: the
  // replacement's `connected` is the one that fires after Offline mode off.
  const bindCurrentClient = (): Client => {
    const client = getWsClient();
    if (client !== boundClient) {
      unbindConnected?.();
      boundClient = client;
      unbindConnected = client.on('connected', handlers.connected);
    }
    return client;
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer) return;
    // Don't arm a timer during an outage — the connectivity listener
    // below is a better wake-up than a 30s ladder that can only fail.
    if (getConnectivitySnapshot().effectiveOffline) {
      deferredForConnectivity = true;
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** retryAttempt);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startSubscription();
    }, delayMs);
  };

  const startSubscription = () => {
    if (disposed) return;
    if (getConnectivitySnapshot().effectiveOffline) {
      deferredForConnectivity = true;
      return;
    }
    const client = bindCurrentClient();
    subscriptionGeneration += 1;
    const generation = subscriptionGeneration;
    unsubscribeStats = client.subscribe<ClimbStatsUpdatedSubscriptionResponse>(
      {
        query: CLIMB_STATS_UPDATED_SUBSCRIPTION,
        variables: { boardType, layoutId },
      },
      {
        next: (result) => {
          if (generation !== subscriptionGeneration) return;
          retryAttempt = 0;
          const event = result.data?.climbStatsUpdated;
          if (event) handlers.next(event);
        },
        error: (error) => {
          if (generation !== subscriptionGeneration) return;
          unsubscribeStats = null;
          handlers.error(error);
          scheduleRetry();
        },
        complete: () => {
          if (generation !== subscriptionGeneration) return;
          unsubscribeStats = null;
          scheduleRetry();
        },
      },
    );
  };

  // Let go of a disposed client at once and park. Offline mode is the usual
  // dispose, and the connectivity listener below restarts the stream on its
  // edge, on the client current then. Any other dispose (a sign-in to another
  // account) takes the normal retry ladder onto the next client.
  const unsubscribeClientDisposed = subscribeWsClientDisposed((disposedClient) => {
    if (disposed || disposedClient !== boundClient) return;
    releaseBoundClient();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
    if (getConnectivitySnapshot().effectiveOffline) {
      deferredForConnectivity = true;
    } else {
      scheduleRetry();
    }
  });

  // One resubscribe per outage, on the edge back to reachable: the flag
  // gates it, so the store's other snapshot changes can't re-enter here.
  // `retryAttempt` resets so the first post-outage failure retries fast
  // rather than inheriting the pre-outage ladder position.
  const unsubscribeConnectivity = subscribeConnectivity(() => {
    if (deferredForConnectivity && !getConnectivitySnapshot().effectiveOffline) {
      deferredForConnectivity = false;
      retryAttempt = 0;
      startSubscription();
    }
  });
  startSubscription();
  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    releaseBoundClient();
    unsubscribeClientDisposed();
    unsubscribeConnectivity();
  };
}
