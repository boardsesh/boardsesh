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
 * Every listed board config, for the boards sitemap shard.
 *
 * Deliberately **not** the swallow-and-return-`[]` wrapper above: a sitemap that
 * silently loses its URLs tells Google those pages were deleted. The shard route
 * turns a throw into a 503 so the crawler retries and keeps the last good copy.
 *
 * `hasMore` is the same rule applied to the API cap. The listed-config count grows
 * with the board catalogue — a new vendor is one merge away — and 100 is the
 * schema ceiling, so the fix when this fires is paging (`offset`), not a bigger
 * constant. Throwing turns "quietly dropped the tail with a 200" into a 503.
 */
export async function getAllBoardConfigsOrThrow(): Promise<PopularBoardConfig[]> {
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
}
