import type { SitemapItem } from './entries';

/**
 * Declared-empty shard. The route exists so filling it is one builder away.
 *
 * `/setter/[setter_username]` cannot be submitted yet:
 *   1. `setter-profile-content.tsx` is a client component that fetches in a
 *      `useEffect` with `loading` initialised true, so the first server HTML is
 *      a spinner — no `<h1>`, no copy. "No indexable spinner-only pages" is a
 *      standing repo rule.
 *   2. `getSetterOgSummary` never returns null (it falls back to the raw
 *      username), so `/setter/{anything}` answers 200. Submitting that would be
 *      a soft-404 farm spending crawl budget the climb shards need.
 *
 * The dev database has 108,000 distinct (board, setter) pairs, so this shard
 * needs paging as well as an SSR fragment before it can ship.
 */
export function buildSetterEntries(): SitemapItem[] {
  return [];
}
