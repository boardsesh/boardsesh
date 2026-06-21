import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { PlannedClimbSlot } from '@boardsesh/playlist-generator';
import { getHttpClient } from '../../../lib/graphql/client';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../lib/graphql/operations';
import {
  buildPools,
  selectItemsFromPools,
  type PreviewFetchContext,
  type PreviewFilters,
} from './workout-preview-pool';

const POOL_SIZE_PER_GRADE = 50;

type SelectClimbsForPlanOptions = {
  /** Authenticated session — gates climbBias's hide/show-attempted filters,
   *  which require auth on the backend. */
  isAuthenticated?: boolean;
  /** Filters that survived the generator UI; mapped onto SEARCH_CLIMBS the
   *  same way the web `playlist-generator-drawer` maps them. */
  filters?: PreviewFilters;
};

/**
 * Build the SEARCH_CLIMBS input for a single target grade. Same mapping as the
 * web `playlist-generator-drawer`: quality-sorted pool, optional ascent/rating/
 * tall filters, and the auth-gated climbBias hide/show flags (anonymous users
 * skip those entirely — the server rejects them without a user context).
 */
export function buildClimbSearchInput(grade: number, ctx: PreviewFetchContext): ClimbSearchInput {
  const { board, isAuthenticated, filters } = ctx;
  return {
    boardName: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
    minGrade: grade,
    maxGrade: grade,
    gradeAccuracy: 'moderate',
    pageSize: POOL_SIZE_PER_GRADE,
    page: 0,
    // Quality-sorted so the generator favours the better climbs at each grade
    // rather than whatever happens to be most-recently published.
    sortBy: 'quality',
    sortOrder: 'desc',
    ...(filters?.minAscents != null ? { minAscents: filters.minAscents } : {}),
    ...(filters?.minRating != null ? { minRating: filters.minRating } : {}),
    ...(filters?.onlyTallClimbs ? { onlyTallClimbs: true } : {}),
    ...(filters?.onlyWideClimbs ? { onlyWideClimbs: true } : {}),
    ...(isAuthenticated && filters?.climbBias === 'unfamiliar' ? { hideAttempted: true, hideCompleted: true } : {}),
    ...(isAuthenticated && filters?.climbBias === 'attempted' ? { showOnlyAttempted: true } : {}),
  };
}

/**
 * Fetch the candidate climb pool for one grade. The mobile-only fetcher injected
 * into `@boardsesh/playlist-generator`'s pure pool helpers; the shared package
 * intentionally stays platform-agnostic (no GraphQL client). Shuffling happens
 * in `buildPools`, not here, so a refetch-on-refresh reshuffles.
 */
export async function fetchGradePool(grade: number, ctx: PreviewFetchContext): Promise<Climb[]> {
  const input = buildClimbSearchInput(grade, ctx);
  const response = await getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
  return response.searchClimbs.climbs.slice();
}

/**
 * Turn a workout plan from `@boardsesh/playlist-generator` into a queue of
 * actual climbs by sampling SEARCH_CLIMBS one grade at a time. Mobile-only;
 * the equivalent web path lives in `playlist-generator-drawer.tsx`.
 */
export async function selectClimbsForPlan(
  slots: PlannedClimbSlot[],
  board: UserBoard,
  options?: SelectClimbsForPlanOptions,
): Promise<ClimbQueueItem[]> {
  const ctx: PreviewFetchContext = {
    board,
    isAuthenticated: options?.isAuthenticated ?? false,
    filters: options?.filters,
  };
  const pools = await buildPools(slots, ctx, fetchGradePool);
  return selectItemsFromPools(slots, pools).items.map((preview) => preview.item);
}
