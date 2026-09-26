import type { Climb } from '@boardsesh/shared-schema';
import type { ParsedBoardRouteParameters, ClimbSearchParams } from '../../../db/queries/climbs/index';

/**
 * Context object passed from searchClimbs query to ClimbSearchResult field resolvers.
 * This allows each field (climbs, totalCount, hasMore) to be resolved independently.
 */
export type ClimbSearchContext = {
  params: ParsedBoardRouteParameters;
  searchParams: ClimbSearchParams;
  userId: string | undefined;
  // Cached results to avoid duplicate queries when multiple fields are requested
  _cachedClimbs?: Climb[];
  _cachedHasMore?: boolean;
  _cachedTotalCount?: number;
  /** True when the query has no user-specific filters and results can be cached in Redis */
  _isCacheable?: boolean;
  /**
   * True for a popular-sort page every viewer sees the same way. Such a page is
   * read through `readPopularPage`: Redis (24 h where `_isCacheable`, else
   * 10 min) with single-flight on the miss. See `climbs/popular-page-cache.ts`.
   */
  _isPopularPageCacheable?: boolean;
};

/**
 * Input type for createSession mutation
 */
export type CreateSessionInput = {
  boardPath: string;
  latitude: number;
  longitude: number;
  name?: string;
  discoverable: boolean;
  goal?: string;
  isPermanent?: boolean;
  boardIds?: number[];
  color?: string;
  /** Absent or null means public. */
  isPublic?: boolean | null;
};

/**
 * Maximum retries for version conflicts in queue operations
 */
export const MAX_RETRIES = 3;
