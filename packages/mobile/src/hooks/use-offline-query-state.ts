import type { ConnectivityReason } from '../lib/connectivity/connectivity-store';
import { useConnectivity } from '../lib/connectivity/use-connectivity';
import { assertNever } from '../lib/assert-never';

/**
 * The subset of a React Query result this module reads. Kept structural (rather
 * than importing `UseQueryResult`) so `useInfiniteQuery` results, `useQueries`
 * entries and hand-rolled snapshots all fit, and so the pure reducer below is
 * testable without a QueryClient.
 */
export type OfflineQueryInput = {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  data?: unknown;
};

/**
 * Why a screen has nothing to render, and — for the three offline flavours —
 * who to blame for it. `'offline'` is the phone with no signal, `'offline_mode'`
 * is a switch the climber flipped themselves, `'backend_unreachable'` is us
 * being down, and `'error'` is a request that reached a reachable server and
 * failed anyway.
 */
export type OfflineQueryReason = 'offline' | 'offline_mode' | 'backend_unreachable' | 'error';

/**
 * The connectivity facts the reducer reads — a structural subset of
 * `ConnectivitySnapshot`, so the pure reducer stays testable without the store.
 */
export type OfflineQueryConnectivity = {
  effectiveOffline: boolean;
  reason: ConnectivityReason | null;
};

export type OfflineQueryState = {
  /**
   * Effectively offline: no signal, OR our backend unreachable, OR Offline mode
   * on. Named for the question callers actually ask ("can this screen reach
   * anything?"), not for the device radio alone.
   */
  isOffline: boolean;
  /**
   * These queries cannot produce data right now AND have none to fall back on,
   * so the screen has nothing honest to render. Show `OfflineState`.
   */
  isBlocked: boolean;
  /** Why it is blocked, or `null` when it is not. */
  reason: OfflineQueryReason | null;
};

/**
 * The store's verdict as a placard reason — the single ladder every offline
 * surface reads, so the boards picker, the discover hub and the per-query
 * placard can never disagree about who is at fault. `device_offline` and "no
 * verdict at all" both land on `'offline'`: the phone is the only thing left to
 * blame.
 *
 * Exhaustive on purpose. A fourth `ConnectivityReason` has to be a compile error
 * here — silently defaulting a new outage kind to "no signal" is the exact bug
 * #4862 was filed for.
 */
export function offlineReasonFor(reason: ConnectivityReason | null): OfflineQueryReason {
  switch (reason) {
    case 'backend_unreachable':
      return 'backend_unreachable';
    case 'offline_mode':
      return 'offline_mode';
    case 'device_offline':
    case null:
      return 'offline';
    default:
      return assertNever(reason);
  }
}

/**
 * Why this exists: `query-provider.tsx` sets `networkMode: 'offlineFirst'`, so a
 * network-only query with no signal fires once, fails, and then **pauses**. Its
 * `status` stays `'pending'` forever, which every screen in the app reads as
 * "still loading". The result is a permanent spinner, or — on screens that
 * render an empty list while pending — a lying "you have no playlists yet".
 *
 * `fetchStatus === 'paused'` is the honest signal: React Query knows it cannot
 * even try. An `error` status while effectively offline means the same thing
 * (the request lost the race with a connectivity change). An `error` while
 * everything is genuinely reachable is a different failure and must not claim
 * "no signal".
 *
 * React Query only ever knows "the network layer said no", so once we know the
 * screen is blocked-because-offline the connectivity store has to say WHICH
 * offline this is: our server being down reads nothing like the phone having no
 * bars, and neither reads like a switch the climber flipped themselves.
 *
 * Any query that already carries data wins over all of that: stale rows beat an
 * offline placard, so a partially-loaded screen stays rendered.
 */
export function deriveOfflineQueryState(
  queries: readonly OfflineQueryInput[],
  connectivity: OfflineQueryConnectivity,
): OfflineQueryState {
  const { effectiveOffline, reason: connectivityReason } = connectivity;
  const hasAnyData = queries.some((query) => query.data !== undefined && query.data !== null);
  const anyPaused = queries.some((query) => query.fetchStatus === 'paused');
  const anyErrored = queries.some((query) => query.status === 'error');

  const isBlocked = !hasAnyData && (anyPaused || anyErrored);
  if (!isBlocked) return { isOffline: effectiveOffline, isBlocked: false, reason: null };

  // A paused query is React Query's own "the network is down" verdict, which is
  // more reliable than a stale store read, so it outranks `effectiveOffline`.
  if (anyPaused || effectiveOffline) {
    return { isOffline: effectiveOffline, isBlocked: true, reason: offlineReasonFor(connectivityReason) };
  }

  return { isOffline: effectiveOffline, isBlocked: true, reason: 'error' };
}

/**
 * Reactive `{ isOffline, isBlocked, reason }` for one query or a set of them.
 * Pass every query the screen needs before it can render anything meaningful;
 * if any of them has data the screen is not blocked.
 *
 * Deliberately not memoized: the reducer is three array scans over a handful of
 * entries, and React Query hands back a fresh result object each render anyway,
 * so a `useMemo` here would need a hand-rolled dependency fingerprint to buy
 * anything at all.
 */
export function useOfflineQueryState(queries: OfflineQueryInput | readonly OfflineQueryInput[]): OfflineQueryState {
  const connectivity = useConnectivity();
  const list: readonly OfflineQueryInput[] = Array.isArray(queries)
    ? (queries as readonly OfflineQueryInput[])
    : [queries as OfflineQueryInput];
  return deriveOfflineQueryState(list, connectivity);
}
