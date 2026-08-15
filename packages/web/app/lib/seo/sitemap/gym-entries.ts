import type { SitemapItem } from './entries';

/**
 * Declared-empty shard. The route exists and returns a valid `<urlset>` so
 * #4381 only has to fill this builder.
 *
 * It cannot carry URLs yet for two reasons:
 *   1. There is no public-gyms enumeration query — `searchGyms` and `myGyms`
 *      are both input-driven, so nothing can list the directory.
 *   2. The gym-discovery epic (#4372) gates the gyms shard behind draining the
 *      duplicate queue: indexing a directory with live duplicates is an SEO
 *      own-goal, and indexed duplicates outlive their merges in Google's cache.
 *
 * Until then, gym pages stay reachable through crawlable links from kiosk and
 * board pages.
 */
export function buildGymEntries(): SitemapItem[] {
  return [];
}
