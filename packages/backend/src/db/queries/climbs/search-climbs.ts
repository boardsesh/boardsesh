import type { RequestDbInstance } from '../../client';
import { searchClimbs as sharedSearchClimbs, type BoardRouteParams, type ClimbSearchParams } from '@boardsesh/db/queries';
import type { Climb, ClimbSearchResult } from '@boardsesh/shared-schema';

// Re-export shared types for backward compatibility
export type { ClimbSearchParams, BoardRouteParams as ParsedBoardRouteParameters };

export const searchClimbs = async (
  db: RequestDbInstance,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<ClimbSearchResult> => {
  try {
    const result = await sharedSearchClimbs(db, params, searchParams, userId);

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
    console.error('Error in searchClimbs:', error);
    throw error;
  }
};
