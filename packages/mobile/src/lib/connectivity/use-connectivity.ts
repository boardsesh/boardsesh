import { useCallback, useSyncExternalStore } from 'react';
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

/**
 * One field of the same machine. `useConnectivity()` re-renders on EVERY
 * snapshot change — `probing` alone flips twice per rung of the backoff ladder
 * — so a component that only cares whether offline mode is on would re-render
 * through a whole outage for nothing. This narrows the subscription to what the
 * caller reads.
 *
 * `select` must return a primitive, or a reference that is stable while the
 * value is unchanged: `useSyncExternalStore` compares with `Object.is`, and a
 * selector that builds a fresh object every call reads as "changed on every
 * commit" and loops until React's update-depth guard fires. Hoist the selector
 * to module scope so its identity is stable too.
 *
 * @param select - MUST be a stable, module-scoped reference (e.g. the hoisted
 *   `selectOfflineMode` below), never an inline arrow: the reader is memoized
 *   on it, so a new identity each render re-registers the subscription on
 *   every commit.
 */
export function useConnectivityField<Field>(select: (snapshot: ConnectivitySnapshot) => Field): Field {
  // Stable per selector: `useSyncExternalStore` re-subscribes when its snapshot
  // reader changes identity, so a fresh closure every render would churn the
  // subscription on each commit even though the selector never moved.
  const readSelectedField = useCallback(() => select(getConnectivitySnapshot()), [select]);
  return useSyncExternalStore(subscribeConnectivity, readSelectedField, readSelectedField);
}

/** Hoisted for `useConnectivityField`: the deliberate offline-mode switch only. */
export function selectOfflineMode(snapshot: ConnectivitySnapshot): boolean {
  return snapshot.offlineMode;
}
