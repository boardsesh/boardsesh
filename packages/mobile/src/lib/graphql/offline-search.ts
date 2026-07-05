import { onlineManager } from '@tanstack/react-query';
import type { Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import { getDatabaseHandle } from '../../db';
import { searchClimbsLocal, countClimbsLocal, isOfflineSearchSupported } from '../../db/queries/search-climbs-local';
import { getClimbLocal } from '../../db/queries/get-climb-local';
import { isBoardDownloadedLocally } from '../../db/queries/board-download-status';
import { getHttpClient } from './client';
import {
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  GET_CLIMB,
  type SearchClimbsQueryResponse,
  type SearchClimbsCountQueryResponse,
  type GetClimbQueryResponse,
  type GetClimbQueryVariables,
} from './operations';

/**
 * Source selection for climb reads. Online → always the network (fresh + every
 * filter). Offline → local SQLite when the active board's exact (type, layout,
 * size) scope is downloaded and the filters are expressible on-device; otherwise
 * an empty/null result rather than a doomed request. Kept as plain async functions
 * (not hooks) so the React Query queryFns and the play-drawer prefetch share them;
 * connectivity is read live via onlineManager and also folded into the query key
 * (see the hooks) so a flip swaps cache entries.
 */

type SearchResult = { climbs: Climb[]; hasMore: boolean };

const EMPTY_SEARCH: SearchResult = { climbs: [], hasMore: false };

function scopeOf(input: { boardName: string; layoutId: number; sizeId: number }) {
  return { boardType: input.boardName, layoutId: input.layoutId, sizeId: input.sizeId };
}

export async function resolveClimbSearch(input: ClimbSearchInput): Promise<SearchResult> {
  const db = getDatabaseHandle();
  if (!onlineManager.isOnline() && db) {
    if (isOfflineSearchSupported(input) && (await isBoardDownloadedLocally(db, scopeOf(input)))) {
      return searchClimbsLocal(db, input);
    }
    return EMPTY_SEARCH;
  }
  const response = await getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
  return response.searchClimbs;
}

export async function resolveClimbSearchCount(input: ClimbSearchInput): Promise<number> {
  const db = getDatabaseHandle();
  if (!onlineManager.isOnline() && db) {
    if (isOfflineSearchSupported(input) && (await isBoardDownloadedLocally(db, scopeOf(input)))) {
      return countClimbsLocal(db, input);
    }
    return 0;
  }
  const response = await getHttpClient().request<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input });
  return response.searchClimbs.totalCount;
}

export async function resolveClimb(variables: GetClimbQueryVariables): Promise<Climb | null> {
  const db = getDatabaseHandle();
  if (!onlineManager.isOnline() && db) {
    if (await isBoardDownloadedLocally(db, scopeOf(variables))) {
      return getClimbLocal(db, {
        boardName: variables.boardName,
        layoutId: variables.layoutId,
        angle: variables.angle,
        climbUuid: variables.climbUuid,
      });
    }
    return null;
  }
  const response = await getHttpClient().request<GetClimbQueryResponse>(GET_CLIMB, variables);
  return response.climb;
}
