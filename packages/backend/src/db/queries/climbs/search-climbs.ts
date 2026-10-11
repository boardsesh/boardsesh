import { dbRead } from '../../client';
import {
  searchClimbs as sharedSearchClimbs,
  type BoardRouteParams,
  type ClimbSearchParams,
} from '@boardsesh/db/queries';
import type { Climb, ClimbSearchResult } from '@boardsesh/shared-schema';
import { logger } from '../../../utils/logger';

// Re-export shared types for backward compatibility
export type { ClimbSearchParams, BoardRouteParams as ParsedBoardRouteParameters };

export const searchClimbs = async (
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<ClimbSearchResult> => {
  try {
    const result = await sharedSearchClimbs(dbRead, params, searchParams, userId);

    // Map ClimbRow to Climb (add fields expected by the GraphQL schema)
    const climbs: Climb[] = result.climbs.map((row) => ({
      ...row,
      mirrored: null,
    }));

    return {
      climbs,
      hasMore: result.hasMore,
      totalCount: 0, // Resolved lazily by the totalCount field resolver
    };
  } catch (error) {
    logger.error('Error in searchClimbs:', error);
    throw error;
  }
};
