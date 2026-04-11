import type { Climb } from '@boardsesh/shared-schema';
import { searchClimbs as searchClimbsQuery, countClimbs } from '../../../db/queries/climbs/index';
import type { ClimbSearchContext } from '../shared/types';
import { searchCache, DEFAULT_SEARCH_CACHE_TTL } from '../../../services/search-cache';

interface CachedClimbsResult {
  climbs: Climb[];
  hasMore: boolean;
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
    if (parent._cachedClimbs !== undefined) {
      return parent._cachedClimbs;
    }

    // User-specific queries bypass Redis cache entirely
    if (!parent._isCacheable) {
      const result = await searchClimbsQuery(parent.db, parent.params, parent.searchParams, parent.userId);
      parent._cachedClimbs = result.climbs;
      parent._cachedHasMore = result.hasMore;
      return result.climbs;
    }

    const cacheKey = searchCache.buildCacheKey(parent.params, parent.searchParams, 'climbs');
    const cached = await searchCache.getCachedResult<CachedClimbsResult>(cacheKey);
    if (cached) {
      parent._cachedClimbs = cached.climbs;
      parent._cachedHasMore = cached.hasMore;
      return cached.climbs;
    }

    // Cache miss — query DB and store in Redis
    const result = await searchClimbsQuery(parent.db, parent.params, parent.searchParams, parent.userId);
    parent._cachedClimbs = result.climbs;
    parent._cachedHasMore = result.hasMore;

    searchCache.setCachedResult(cacheKey, { climbs: result.climbs, hasMore: result.hasMore }, DEFAULT_SEARCH_CACHE_TTL);
    return result.climbs;
  },

  /**
   * Resolve the total count of climbs matching the search criteria
   * Uses Redis caching for anonymous queries
   */
  totalCount: async (parent: ClimbSearchContext): Promise<number> => {
    if (parent._cachedTotalCount !== undefined) {
      return parent._cachedTotalCount;
    }

    if (!parent._isCacheable) {
      const count = await countClimbs(parent.db, parent.params, parent.searchParams, parent.userId);
      parent._cachedTotalCount = count;
      return count;
    }

    const cacheKey = searchCache.buildCacheKey(parent.params, parent.searchParams, 'count');
    const cached = await searchCache.getCachedResult<number>(cacheKey);
    if (cached !== null) {
      parent._cachedTotalCount = cached;
      return cached;
    }

    const count = await countClimbs(parent.db, parent.params, parent.searchParams, parent.userId);
    parent._cachedTotalCount = count;

    searchCache.setCachedResult(cacheKey, count, DEFAULT_SEARCH_CACHE_TTL);
    return count;
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
