import { parseTickTime, tickTimeMs } from '@boardsesh/profile-stats';

export type FeedRecencyBucket = 'today' | 'thisWeek' | 'earlier';

/** Minimal shape needed to bucket a session by recency. */
type RecencySession = { lastTickAt: string };

export type FeedSessionGroup<TSession extends RecencySession> = {
  bucket: FeedRecencyBucket;
  sessions: TSession[];
};

// Bucket order is fixed (most recent first); empty buckets are dropped.
const BUCKET_ORDER: FeedRecencyBucket[] = ['today', 'thisWeek', 'earlier'];

/** Minimal shape needed to de-duplicate a session by its id. */
type IdentifiableSession = { sessionId: string };

/**
 * De-duplicate a flattened, multi-page session feed by `sessionId`, keeping the
 * first occurrence (i.e. the earlier page wins). The backend feed uses OFFSET
 * pagination over an `ORDER BY session_last_tick DESC` that mutates whenever a
 * tick lands, so a session straddling a page boundary during a refetch can be
 * returned in two adjacent pages. Without this guard the duplicate `sessionId`
 * becomes a duplicate FlashList key (React duplicate-key warning + a doubled or
 * dropped row). Pure and order-preserving.
 */
export function dedupeSessionsById<TSession extends IdentifiableSession>(sessions: TSession[]): TSession[] {
  const byId = new Map<string, TSession>();
  for (const session of sessions) {
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
  }
  return [...byId.values()];
}

/**
 * Group sessions into Today / This week / Earlier buckets by their `lastTickAt`,
 * sorted most-recent-first within each bucket and across buckets. Pure: `now` is
 * injected (never `Date.now()` internally) so callers and tests control the
 * clock. "Today" is the same local calendar day as `now`; "This week" is within
 * the trailing 7 days but not today; everything older is "Earlier".
 */
export function bucketSessionsByRecency<TSession extends RecencySession>(
  sessions: TSession[],
  now: number,
): FeedSessionGroup<TSession>[] {
  const startOfToday = parseTickTime(new Date(now).toISOString()).startOf('day').valueOf();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const grouped: Record<FeedRecencyBucket, TSession[]> = { today: [], thisWeek: [], earlier: [] };

  // Sort a copy newest-first so each bucket comes out ordered without re-sorting.
  const sorted = [...sessions].sort((left, right) => tickTimeMs(right.lastTickAt) - tickTimeMs(left.lastTickAt));

  for (const session of sorted) {
    const at = tickTimeMs(session.lastTickAt);
    if (at >= startOfToday) grouped.today.push(session);
    else if (at >= sevenDaysAgo) grouped.thisWeek.push(session);
    else grouped.earlier.push(session);
  }

  return BUCKET_ORDER.filter((bucket) => grouped[bucket].length > 0).map((bucket) => ({
    bucket,
    sessions: grouped[bucket],
  }));
}
