import 'server-only';
import { unstable_cache } from 'next/cache';
import { GET_POPULAR_BOARD_CONFIGS, type GetPopularBoardConfigsQueryResponse } from '@boardsesh/graphql/operations';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

const CACHE_TAG = 'popular-board-configs';
const REVALIDATE_SECONDS = 300;
const FETCH_TIMEOUT_MS = 3000;

const fetchPopularBoardConfigs = unstable_cache(
  async (): Promise<PopularBoardConfig[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const result = await executeGraphQLInternal<GetPopularBoardConfigsQueryResponse>(
        GET_POPULAR_BOARD_CONFIGS,
        { input: { limit: 12, offset: 0 } },
        controller.signal,
      );
      return result.popularBoardConfigs.configs;
    } finally {
      clearTimeout(timer);
    }
  },
  ['popular-board-configs'],
  { revalidate: REVALIDATE_SECONDS, tags: [CACHE_TAG] },
);

export async function getPopularBoardConfigs(): Promise<PopularBoardConfig[]> {
  try {
    return await fetchPopularBoardConfigs();
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[home-page-ssr] popularBoardConfigs fetch failed:', err instanceof Error ? err.message : err);
    }
    return [];
  }
}

// `PopularBoardConfigsInputSchema` caps `limit` at 100 — this is the hard schema
// max, not a tuning knob, so the tail past it can only be reached by paging.
// The resolver listed 51 configs when this shipped.
const SITEMAP_LIMIT = 100;
const SITEMAP_FETCH_TIMEOUT_MS = 10_000;

/**
 * One hour — the same number as the `s-maxage=3600` the boards shard route serves
 * under, but not a claim that the two expire together: that route's header
 * carries a day of `stale-while-revalidate` on top, so the CDN can hand out a body
 * up to 25 hours old whatever this entry does. It is one window picked for one
 * reason on both layers. The board catalogue moves on the order of a merge — a new
 * layout or vendor — never on the order of minutes, so an hour is generous
 * freshness for a file crawlers refetch in days.
 */
const SITEMAP_REVALIDATE_SECONDS = 3_600;
/**
 * Decorative today: nothing calls `revalidateTag` on it, so the entry only ever
 * expires on the clock above. Named anyway so a future catalogue write has one
 * thing to invalidate instead of inventing a key.
 */
const SITEMAP_CACHE_TAG = 'sitemap-board-configs';
/** Same window in front of the Data Cache (which does not dedupe misses). */
const SITEMAP_TTL_MS = SITEMAP_REVALIDATE_SECONDS * 1_000;

/**
 * Every listed board config, for the sitemap.
 *
 * Deliberately **not** the swallow-and-return-`[]` wrapper above: a sitemap that
 * silently loses its URLs tells Google those pages were deleted. The shard route
 * turns a throw into a 503 so the crawler retries and keeps the last good copy.
 * The in-process layer below stores nothing on a rejection, so a failing fetch
 * stays a failing fetch rather than a poisoned hour of empty sitemaps — that is
 * the half a test pins. Whether the Data Cache also declines to memoise the
 * rejection is unverified here (the test mocks `unstable_cache` to a
 * pass-through), so do not lean on it.
 *
 * `hasMore` is the same rule applied to the API cap. The listed-config count grows
 * with the board catalogue — a new vendor is one merge away — and 100 is the
 * schema ceiling, so the fix when this fires is paging (`offset`), not a bigger
 * constant. Throwing turns "quietly dropped the tail with a 200" into a 503.
 */
const fetchAllBoardConfigs = unstable_cache(
  async (): Promise<PopularBoardConfig[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SITEMAP_FETCH_TIMEOUT_MS);
    try {
      const result = await executeGraphQLInternal<GetPopularBoardConfigsQueryResponse>(
        GET_POPULAR_BOARD_CONFIGS,
        { input: { limit: SITEMAP_LIMIT, offset: 0 } },
        controller.signal,
      );
      const { configs, hasMore, totalCount } = result.popularBoardConfigs;
      if (hasMore) {
        throw new Error(
          `[sitemap] boards shard truncated: ${configs.length} of ${totalCount} listed configs came back at the ${SITEMAP_LIMIT}-config API cap — page it with offset instead of raising the limit.`,
        );
      }
      return configs;
    } finally {
      clearTimeout(timer);
    }
  },
  ['all-board-configs'],
  { revalidate: SITEMAP_REVALIDATE_SECONDS, tags: [SITEMAP_CACHE_TAG] },
);

let cachedAllConfigs: { builtAt: number; configs: PopularBoardConfig[] } | null = null;
let allConfigsInFlight: Promise<PopularBoardConfig[]> | null = null;

/**
 * The listed board configs, behind the Next Data Cache plus an in-process TTL and
 * single-flight — the same two-layer shape `fetchTier2Summary` uses, for the same
 * reason.
 *
 * Uncached, this was a bare `executeGraphQLInternal` call measured at ~10 s cold
 * in production, and `/sitemap.xml` is `force-dynamic`, so every CDN miss re-ran
 * it live and blew the index's `SHARD_DEADLINE_MS` — publishing an index with no
 * boards shard at all (#4519). The Data Cache is what makes the deadline
 * reachable across instances.
 *
 * The in-process layer is not redundant with it. `unstable_cache` does not
 * deduplicate concurrent misses, and a single cold `/sitemap.xml` already calls
 * this twice in parallel — once for the boards shard and once through the climbs
 * summary — before a crawl burst adds `/sitemaps/boards.xml` and every climbs
 * page on top. Sharing one in-flight promise turns that into one fetch.
 *
 * A miss still degrades rather than hangs: the fetch keeps its own 10 s abort and
 * the index stops waiting after `SHARD_DEADLINE_MS`, so the worst a cold start
 * costs is one minute of degraded index while the abandoned fetch populates both
 * layers for the next request.
 */
export async function getAllBoardConfigsOrThrow(): Promise<PopularBoardConfig[]> {
  if (cachedAllConfigs && Date.now() - cachedAllConfigs.builtAt < SITEMAP_TTL_MS) {
    return cachedAllConfigs.configs;
  }
  if (allConfigsInFlight) {
    return allConfigsInFlight;
  }

  const build = fetchAllBoardConfigs().then((configs) => {
    cachedAllConfigs = { builtAt: Date.now(), configs };
    return configs;
  });
  allConfigsInFlight = build;

  try {
    return await build;
  } finally {
    allConfigsInFlight = null;
  }
}

/** Test seam: drops the in-process TTL cache and any in-flight fetch. */
export function resetBoardConfigCacheForTests(): void {
  cachedAllConfigs = null;
  allConfigsInFlight = null;
}
