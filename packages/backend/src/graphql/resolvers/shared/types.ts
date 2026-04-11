import type { Climb } from '@boardsesh/shared-schema';
import type { ParsedBoardRouteParameters, ClimbSearchParams } from '../../../db/queries/climbs/index';
import type { RequestDbInstance } from '../../../db/client';

/**
 * Context object passed from searchClimbs query to ClimbSearchResult field resolvers.
 * This allows each field (climbs, totalCount, hasMore) to be resolved independently.
 */
export type ClimbSearchContext = {
  /**
   * Request-scoped db handle captured in the top-level searchClimbs resolver so
   * the field resolvers don't need to call `createRequestDb()` themselves.
   */
  db: RequestDbInstance;
  params: ParsedBoardRouteParameters;
  searchParams: ClimbSearchParams;
  userId: string | undefined;
  // Cached results to avoid duplicate queries when multiple fields are requested
  _cachedClimbs?: Climb[];
  _cachedHasMore?: boolean;
  _cachedTotalCount?: number;
  /** True when the query has no user-specific filters and results can be cached in Redis */
  _isCacheable?: boolean;
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
};

/**
 * Maximum retries for version conflicts in queue operations
 */
export const MAX_RETRIES = 3;
