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
  // Analytics deferred from the resolver so the Search Climbs event can carry
  // resultCount once the climbs field has actually executed. The flag prevents
  // duplicate emission when both `climbs` and `totalCount` field resolvers run.
  _analyticsDistinctId?: string;
  _analyticsBaseProperties?: Record<string, string | number | boolean | null>;
  _analyticsEmitted?: boolean;
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
