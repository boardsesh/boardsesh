import type { Climb } from '@boardsesh/shared-schema';
import { searchClimbs as searchClimbsQuery, countClimbs } from '../../../db/queries/climbs/index';
import type { ClimbSearchContext } from '../shared/types';
import { searchCache, DEFAULT_SEARCH_CACHE_TTL } from '../../../services/search-cache';
import {
  logSearchClimbsMetrics,
  type SearchClimbsMetricDimensions,
  type SearchClimbsMetricSource,
} from './search-metrics';

type CachedClimbsResult = {
  climbs: Climb[];
  hasMore: boolean;
};

/** Pull the stable latency dimensions out of the search context. */
function metricDimensions(parent: ClimbSearchContext): Omit<SearchClimbsMetricDimensions, 'resultCount'> {
  return {
    boardName: parent.params.board_name,
    angle: parent.params.angle,
    page: parent.searchParams.page ?? 0,
    pageSize: parent.searchParams.pageSize ?? 20,
    sortBy: parent.searchParams.sortBy ?? 'ascents',
    cacheable: parent._isCacheable ?? false,
  };
}

/**
 * Field-level resolvers for ClimbSearchResult
 * These resolve individual fields from the context returned by searchClimbs query
 */
export const climbFieldResolvers = {
  /**
   * Resolve the climbs array
   * Uses Redis caching for anonymous queries and in-memory caching to avoid duplicate queries
   */
  climbs: async (parent: ClimbSearchContext): Promise<Climb[]> => {
    const startTime = performance.now();
    const finalize = (climbs: Climb[], source: SearchClimbsMetricSource): Climb[] => {
      logSearchClimbsMetrics('searchClimbs.climbs', performance.now() - startTime, source, {
        ...metricDimensions(parent),
        resultCount: climbs.length,
      });
      return climbs;
    };

    if (parent._cachedClimbs !== undefined) {
      return finalize(parent._cachedClimbs, 'precomputed');
    }

    // User-specific queries bypass Redis cache entirely
    if (!parent._isCacheable) {
      const result = await searchClimbsQuery(parent.params, parent.searchParams, parent.userId);
      parent._cachedClimbs = result.climbs;
      parent._cachedHasMore = result.hasMore;
      return finalize(result.climbs, 'db');
    }

    const cacheKey = searchCache.buildCacheKey(parent.params, parent.searchParams, 'climbs');
    const cached = await searchCache.getCachedResult<CachedClimbsResult>(cacheKey);
    if (cached) {
      parent._cachedClimbs = cached.climbs;
      parent._cachedHasMore = cached.hasMore;
      return finalize(cached.climbs, 'redis');
    }

    // Cache miss — query DB and store in Redis
    const result = await searchClimbsQuery(parent.params, parent.searchParams, parent.userId);
    parent._cachedClimbs = result.climbs;
    parent._cachedHasMore = result.hasMore;

    searchCache.setCachedResult(cacheKey, { climbs: result.climbs, hasMore: result.hasMore }, DEFAULT_SEARCH_CACHE_TTL);
    return finalize(result.climbs, 'db');
  },

  /**
   * Resolve the total count of climbs matching the search criteria
   * Uses Redis caching for anonymous queries
   */
  totalCount: async (parent: ClimbSearchContext): Promise<number> => {
    const startTime = performance.now();
    const finalize = (count: number, source: SearchClimbsMetricSource): number => {
      logSearchClimbsMetrics(
        'searchClimbs.totalCount',
        performance.now() - startTime,
        source,
        metricDimensions(parent),
      );
      return count;
    };

    if (parent._cachedTotalCount !== undefined) {
      return finalize(parent._cachedTotalCount, 'precomputed');
    }

    if (!parent._isCacheable) {
      const count = await countClimbs(parent.params, parent.searchParams, parent.userId);
      parent._cachedTotalCount = count;
      return finalize(count, 'db');
    }

    const cacheKey = searchCache.buildCacheKey(parent.params, parent.searchParams, 'count');
    const cached = await searchCache.getCachedResult<number>(cacheKey);
    if (cached !== null) {
      parent._cachedTotalCount = cached;
      return finalize(cached, 'redis');
    }

    const count = await countClimbs(parent.params, parent.searchParams, parent.userId);
    parent._cachedTotalCount = count;

    searchCache.setCachedResult(cacheKey, count, DEFAULT_SEARCH_CACHE_TTL);
    return finalize(count, 'db');
  },

  /**
   * Resolve whether there are more pages of results
   * Delegates to the climbs resolver logic to benefit from Redis caching
   */
  hasMore: async (parent: ClimbSearchContext): Promise<boolean> => {
    // Return cached result if already fetched (e.g., if climbs was requested first)
    if (parent._cachedHasMore !== undefined) {
      return parent._cachedHasMore;
    }

    // Trigger the climbs resolver which handles both Redis and in-memory caching
    await climbFieldResolvers.climbs(parent);

    // The climbs resolver always sets _cachedHasMore (from DB result or Redis cache).
    // A missing value here would indicate a bug in the climbs resolver.
    if (parent._cachedHasMore === undefined) {
      throw new Error('Invariant violation: climbs resolver did not populate _cachedHasMore');
    }
    return parent._cachedHasMore;
  },
};
