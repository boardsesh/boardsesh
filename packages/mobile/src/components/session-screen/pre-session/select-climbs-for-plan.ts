import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { PlannedClimbSlot } from '@boardsesh/playlist-generator';
import { withGradeSource } from '../../../lib/graphql/hooks/search-grade-source';
import { offlineAwareRequest } from '../../../lib/graphql/offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../lib/graphql/operations';
import {
  buildPools,
  selectItemsFromPools,
  type PreviewFetchContext,
  type PreviewFilters,
} from './workout-preview-pool';

/** Smallest pool fetched per grade: enough to shuffle and refresh from. */
export const POOL_SIZE_PER_GRADE = 50;
/** The backend's `SEARCH_CLIMBS` page-size cap (`ClimbSearchInputSchema.pageSize`, max 100). */
export const MAX_SEARCH_PAGE_SIZE = 100;
/** Spare climbs fetched on top of the slots a grade has to fill, so a refresh has somewhere to go. */
const POOL_SLACK_PER_GRADE = 10;

type SelectClimbsForPlanOptions = {
  /** Authenticated session — gates climbBias's hide/show-attempted filters,
   *  which require auth on the backend. */
  isAuthenticated?: boolean;
  /** Filters that survived the generator UI; mapped onto SEARCH_CLIMBS the
   *  same way the web `playlist-generator-drawer` maps them. */
  filters?: PreviewFilters;
  /** Search on the Boardsesh grade (see `PreviewFetchContext.boardseshGrades`). */
  boardseshGrades?: boolean;
};

/**
 * Build the SEARCH_CLIMBS input for a single target grade. Same mapping as the
 * web `playlist-generator-drawer`: quality-sorted pool, optional ascent/rating/
 * tall filters, and the auth-gated climbBias hide/show flags (anonymous users
 * skip those entirely — the server rejects them without a user context).
 */
export function buildClimbSearchInput(
  grade: number,
  ctx: PreviewFetchContext,
  page = 0,
  pageSize = POOL_SIZE_PER_GRADE,
): ClimbSearchInput {
  const { board, isAuthenticated, filters, boardseshGrades = false } = ctx;
  const input: ClimbSearchInput = {
    boardName: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
    minGrade: grade,
    maxGrade: grade,
    gradeAccuracy: 'moderate',
    pageSize,
    page,
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
  return withGradeSource(input, boardseshGrades);
}

/** How many climbs to fetch for a grade that `demand` slots draw from. */
export function gradePoolTarget(demand: number): number {
  return Math.max(POOL_SIZE_PER_GRADE, demand + POOL_SLACK_PER_GRADE);
}

/**
 * Fetch the candidate climb pool for one grade. The mobile-only fetcher injected
 * into `@boardsesh/playlist-generator`'s pure pool helpers; the shared package
 * intentionally stays platform-agnostic (no GraphQL client). Shuffling happens
 * in `buildPools`, not here, so a refetch-on-refresh reshuffles.
 *
 * The pool is sized by `demand`, the slots that will draw from it: several
 * workout blocks at one grade share one pool, and a fixed 50 would leave the
 * later blocks empty. Past the backend's 100-per-page cap it reads the next
 * pages until it has enough or the grade runs out.
 */
export async function fetchGradePool(grade: number, ctx: PreviewFetchContext, demand = 0): Promise<Climb[]> {
  const target = gradePoolTarget(demand);
  const pageSize = Math.min(target, MAX_SEARCH_PAGE_SIZE);
  // Two pages beyond what the target needs, so a backend that keeps saying
  // hasMore while repeating climbs can't keep the preview loading forever.
  const maxPages = Math.ceil(target / pageSize) + 2;
  const climbs: Climb[] = [];
  const seenUuids = new Set<string>();
  for (let page = 0; climbs.length < target && page < maxPages; page++) {
    const input = buildClimbSearchInput(grade, ctx, page, pageSize);
    const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
    const pageClimbs = response.searchClimbs.climbs;
    for (const climb of pageClimbs) {
      if (seenUuids.has(climb.uuid)) continue;
      seenUuids.add(climb.uuid);
      climbs.push(climb);
    }
    if (!response.searchClimbs.hasMore || pageClimbs.length < pageSize) break;
  }
  return climbs;
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
    boardseshGrades: options?.boardseshGrades ?? false,
  };
  // Every slot shares the one set of filters; the pools read them from the slot.
  const filteredSlots = slots.map((slot) => ({ ...slot, filters: options?.filters }));
  const pools = await buildPools(filteredSlots, ctx, fetchGradePool);
  return selectItemsFromPools(filteredSlots, pools).items.map((preview) => preview.item);
}
