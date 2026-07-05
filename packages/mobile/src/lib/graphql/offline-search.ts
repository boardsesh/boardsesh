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
 * Source selection for climb reads — **local-first**. Whenever the active board's
 * exact (type, layout, size) scope is downloaded and the filters are expressible
 * on-device, read local SQLite even while online: a local query is far faster than
 * a network round-trip, and the background sync (foreground + reconnect) keeps the
 * rows fresh — a completed board pull invalidates ['searchClimbs']/['climb'] so the
 * next local read reflects it. The network is used only when there's no usable local
 * data: the board isn't downloaded, or the filter needs a table we don't sync
 * (hold-state, zone, tall/wide, beta, drafts). Offline with no local data → an
 * empty/null result rather than a doomed request.
 *
 * Plain async functions (not hooks) so the React Query queryFns and the play-drawer
 * prefetch share them. Source is decided live per call; the query key is just the
 * input (no connectivity flag), since a downloaded board reads local regardless of
 * connectivity and the caches self-heal on the post-sync invalidation.
 */

type SearchResult = { climbs: Climb[]; hasMore: boolean };

const EMPTY_SEARCH: SearchResult = { climbs: [], hasMore: false };

function scopeOf(input: { boardName: string; layoutId: number; sizeId: number }) {
  return { boardType: input.boardName, layoutId: input.layoutId, sizeId: input.sizeId };
}

async function canReadLocal(input: ClimbSearchInput): Promise<boolean> {
  const db = getDatabaseHandle();
  return !!db && isOfflineSearchSupported(input) && isBoardDownloadedLocally(db, scopeOf(input));
}

export async function resolveClimbSearch(input: ClimbSearchInput): Promise<SearchResult> {
  const db = getDatabaseHandle();
  if (db && (await canReadLocal(input))) {
    return searchClimbsLocal(db, input);
  }
  if (!onlineManager.isOnline()) return EMPTY_SEARCH;
  const response = await getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
  return response.searchClimbs;
}

export async function resolveClimbSearchCount(input: ClimbSearchInput): Promise<number> {
  const db = getDatabaseHandle();
  if (db && (await canReadLocal(input))) {
    return countClimbsLocal(db, input);
  }
  if (!onlineManager.isOnline()) return 0;
  const response = await getHttpClient().request<SearchClimbsCountQueryResponse>(SEARCH_CLIMBS_COUNT, { input });
  return response.searchClimbs.totalCount;
}

export async function resolveClimb(variables: GetClimbQueryVariables): Promise<Climb | null> {
  const db = getDatabaseHandle();
  // Detail has no filters — local whenever the exact scope is downloaded.
  if (db && (await isBoardDownloadedLocally(db, scopeOf(variables)))) {
    return getClimbLocal(db, {
      boardName: variables.boardName,
      layoutId: variables.layoutId,
      angle: variables.angle,
      climbUuid: variables.climbUuid,
    });
  }
  if (!onlineManager.isOnline()) return null;
  const response = await getHttpClient().request<GetClimbQueryResponse>(GET_CLIMB, variables);
  return response.climb;
}
