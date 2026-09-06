import { useSyncExternalStore } from 'react';
import { getConnectivitySnapshot, subscribeConnectivity, type ConnectivitySnapshot } from './connectivity-store';

/**
 * The reactive read of the connectivity machine (issue #4862). Re-renders only
 * when the snapshot actually changes — the store compares every field before it
 * notifies, so a chatty NetInfo stream or a run of failing requests costs no
 * renders once the derived state has settled.
 *
 * `useIsOffline()` remains the cheap "can we reach anything?" boolean. Reach for
 * this one when the surface has to say WHY (`reason`), offer a retry
 * (`probing`), or show how long an outage has run (`unreachableSince`).
 */
export function useConnectivity(): ConnectivitySnapshot {
  return useSyncExternalStore(subscribeConnectivity, getConnectivitySnapshot, getConnectivitySnapshot);
}
