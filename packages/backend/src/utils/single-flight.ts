/**
 * Collapse concurrent callers of one expensive read onto a single in-flight
 * promise, per process.
 *
 * The home page's two reads — `popularBoardConfigs` and `recentBetaLinks` —
 * are Redis-cached with a long TTL, and both used to fall through to a heavy
 * SQL statement on a miss (`recentBetaLinks` still does; `popularBoardConfigs`
 * now only reads, and a pg-boss job runs its statement). The fall-through had no concurrency control of any
 * kind: N simultaneous requests during a cold window meant N simultaneous
 * copies of the statement, each holding one of the pool's ten connections
 * until it finished. Once the pool was gone every OTHER query in the process
 * queued behind it forever — postgres.js's acquire queue is unbounded and
 * untimed (docs/db-connectivity.md) — so an anonymous `board(boardUuid:)`
 * that normally answers in 50 ms never answered at all, while `{ __typename }`
 * kept answering in single-digit milliseconds through the same event loop.
 *
 * That is the shape #4463 chased for weeks through the e2e suite: the CI
 * backend runs with no `REDIS_URL`, so every home-page render was a cold
 * window, and `/embed/**` renders (which wait on the backend over HTTP) hung
 * for the whole test budget.
 *
 * The distributed Redis locks the refresh jobs take are not a substitute: they
 * only stop a second NODE from refreshing, and are not held on the resolver
 * path at all.
 *
 * Deliberately not a cache. The promise is dropped the moment it settles, so a
 * caller that arrives afterwards runs the read again and no stale value is
 * ever served. Rejections propagate to every joined caller and are likewise
 * not remembered.
 */
const inFlightByKey = new Map<string, Promise<unknown>>();

/**
 * How long a Redis-less deployment (local dev, the e2e CI stack) may answer
 * one of those reads from a process-local copy.
 *
 * Single-flight alone still re-runs the statement for the first caller after
 * every completion, which is a permanent one-connection burn and permanent
 * database load. Used by `recentBetaLinks`; never consulted when Redis is
 * connected, so production freshness is decided by the shared cache.
 */
export const REDISLESS_FALLBACK_TTL_MS = 10 * 60 * 1000;

export function singleFlight<Result>(key: string, run: () => Promise<Result>): Promise<Result> {
  const joined = inFlightByKey.get(key) as Promise<Result> | undefined;
  if (joined) return joined;

  // `run()` is invoked inside the async wrapper so a synchronous throw becomes
  // a rejected promise that still clears the map entry.
  const started = (async () => run())().finally(() => {
    inFlightByKey.delete(key);
  });
  inFlightByKey.set(key, started);
  return started;
}

/** Test-only: drop every tracked promise so one test cannot leak into the next. */
export function resetSingleFlightForTests(): void {
  inFlightByKey.clear();
}
