import { useIsOffline } from './use-is-offline';

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

export type OfflineQueryReason = 'offline' | 'error';

export type OfflineQueryState = {
  /** The device reports no connection. */
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
 * Why this exists: `query-provider.tsx` sets `networkMode: 'offlineFirst'`, so a
 * network-only query with no signal fires once, fails, and then **pauses**. Its
 * `status` stays `'pending'` forever, which every screen in the app reads as
 * "still loading". The result is a permanent spinner, or — on screens that
 * render an empty list while pending — a lying "you have no playlists yet".
 *
 * `fetchStatus === 'paused'` is the honest signal: React Query knows it cannot
 * even try. An `error` status with the device offline means the same thing (the
 * request lost the race with a connectivity change). An `error` while genuinely
 * online is a different failure and must not claim "no signal".
 *
 * Any query that already carries data wins over all of that: stale rows beat an
 * offline placard, so a partially-loaded screen stays rendered.
 */
export function deriveOfflineQueryState(queries: readonly OfflineQueryInput[], isOffline: boolean): OfflineQueryState {
  const hasAnyData = queries.some((query) => query.data !== undefined && query.data !== null);
  const anyPaused = queries.some((query) => query.fetchStatus === 'paused');
  const anyErrored = queries.some((query) => query.status === 'error');

  const isBlocked = !hasAnyData && (anyPaused || anyErrored);
  if (!isBlocked) return { isOffline, isBlocked: false, reason: null };

  // A paused query is React Query's own "the network is down" verdict, which is
  // more reliable than a stale onlineManager read, so it outranks `isOffline`.
  const reason: OfflineQueryReason = anyPaused || isOffline ? 'offline' : 'error';
  return { isOffline, isBlocked: true, reason };
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
  const isOffline = useIsOffline();
  const list: readonly OfflineQueryInput[] = Array.isArray(queries)
    ? (queries as readonly OfflineQueryInput[])
    : [queries as OfflineQueryInput];
  return deriveOfflineQueryState(list, isOffline);
}
