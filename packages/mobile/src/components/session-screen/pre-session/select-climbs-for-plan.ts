import { onlineManager } from '@tanstack/react-query';
import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { ClimbBias, PlannedClimbSlot } from '@boardsesh/playlist-generator';
import { withGradeSource } from '../../../lib/graphql/hooks/search-grade-source';
import { offlineAwareRequest } from '../../../lib/graphql/offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../lib/graphql/operations';
import {
  buildPools,
  selectItemsFromPools,
  type GradePool,
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
 * The personal flags of one search tier: which climbs of a grade it returns,
 * read from your logbook at this angle. Only the flags a tier sets are sent.
 */
export type ClimbSearchTier = Readonly<Pick<ClimbSearchInput, 'hideAttempted' | 'hideCompleted' | 'showOnlyAttempted'>>;

const NEVER_TRIED: ClimbSearchTier = { hideAttempted: true, hideCompleted: true };
const NOT_SENT: ClimbSearchTier = { hideCompleted: true };
const TRIED_NOT_SENT: ClimbSearchTier = { showOnlyAttempted: true, hideCompleted: true };
const TRIED: ClimbSearchTier = { showOnlyAttempted: true };
const ANY_CLIMB: ClimbSearchTier = {};

function tiersForBias(climbBias: ClimbBias, skipSent: boolean): ClimbSearchTier[] {
  switch (climbBias) {
    case 'unfamiliar':
      return skipSent ? [NEVER_TRIED, NOT_SENT] : [NEVER_TRIED, NOT_SENT, ANY_CLIMB];
    case 'attempted':
      return [skipSent ? TRIED_NOT_SENT : TRIED];
    case 'any':
      return [skipSent ? NOT_SENT : ANY_CLIMB];
  }
}

/**
 * The search tiers for one set of filters, best first (#6232). Each tier
 * returns every climb the one before it does and more, and `fetchGradePool`
 * reads them in order until the pool is full, so the later tiers only top it
 * up.
 *
 * - Unfamiliar (the default): never tried, then tried but not sent, then sent.
 *   The first tier is the request this bias always sent, so a grade that fills
 *   from it costs one request, as before, and climbs you have sent only fill
 *   what is left.
 * - Attempted and Any: the one search each always sent, so a climber who picks
 *   them gets their sent climbs mixed in as before.
 *
 * Skip what I've sent keeps only searches that hide sent climbs: Unfamiliar
 * drops its last tier, Attempted keeps the climbs you have tried but not sent,
 * and Any the ones you have not sent. Signed out there is no logbook to read:
 * one tier, no personal flags.
 */
export function searchTiers(filters: PreviewFilters | undefined, isAuthenticated: boolean): ClimbSearchTier[] {
  if (!isAuthenticated || !filters) return [ANY_CLIMB];
  return tiersForBias(filters.climbBias, filters.skipSent === true);
}

/**
 * Build the SEARCH_CLIMBS input for a single target grade and search tier:
 * quality-sorted pool, the optional ascent, rating, tall, wide and benchmark
 * filters, and the tier's personal flags. Signed out those flags are never
 * sent (the server ignores them without a user). A filter that is off adds
 * no key, so the default request stays the one the screenshot fixtures
 * recorded. The tier defaults to the first one the filters search.
 */
export function buildClimbSearchInput(
  grade: number,
  ctx: PreviewFetchContext,
  page = 0,
  pageSize = POOL_SIZE_PER_GRADE,
  tier: ClimbSearchTier = searchTiers(ctx.filters, ctx.isAuthenticated)[0],
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
    ...(filters?.onlyBenchmarks ? { onlyBenchmarks: true } : {}),
    ...(isAuthenticated ? tier : {}),
  };
  return withGradeSource(input, boardseshGrades);
}

/** How many climbs to fetch for a grade that `demand` slots draw from. */
export function gradePoolTarget(demand: number): number {
  return Math.max(POOL_SIZE_PER_GRADE, demand + POOL_SLACK_PER_GRADE);
}

/**
 * How many climbs a top-up tier reads up to: every slot plus the slack, not
 * the 50-climb floor. The floor is refresh headroom, and the first tier's
 * climbs already give a row somewhere to go; a refresh that runs out of them
 * refetches with a bigger demand and reaches the top-ups then.
 */
function topUpTarget(demand: number): number {
  return demand + POOL_SLACK_PER_GRADE;
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
 *
 * It reads the filters' search tiers (`searchTiers`) in order. The first tier
 * reads up to the full target, as the one request always did, so a grade it
 * fills costs what it always did. A later tier is read only while the pool is
 * short of `topUpTarget`. A climb a later tier adds is a top-up, named in
 * `topUpTiers` with the tier it came from. A later tier that fails leaves the
 * pool with what the earlier ones found; only a failing first tier fails the
 * fetch.
 *
 * The pool is `exhausted` when its last tier ran out: it then holds every climb
 * the grade has under these filters, and a rebuild reuses it instead of asking
 * again. A request sent while offline never counts, since the empty offline
 * answer says nothing about the grade. Once `ctx.isCurrent` says the build or
 * refresh is superseded, the fetch sends nothing more and hands back what it has.
 */
export async function fetchGradePool(grade: number, ctx: PreviewFetchContext, demand = 0): Promise<GradePool> {
  const target = gradePoolTarget(demand);
  const topUpLimit = topUpTarget(demand);
  const pageSize = Math.min(target, MAX_SEARCH_PAGE_SIZE);
  // Two pages beyond what the target needs, so a backend that keeps saying
  // hasMore while repeating climbs can't keep the preview loading forever.
  const maxPagesPerTier = Math.ceil(target / pageSize) + 2;
  const allTiers = searchTiers(ctx.filters, ctx.isAuthenticated);
  // Screenshot captures replay recorded SearchClimbs answers by their exact
  // variables, and the pinned set holds one request per pool. Where that first
  // tier came back short (Woods, and MoonBoard at the recorded grade) a second
  // tier has no answer and fails the capture, so a capture reads the first tier
  // only. To show top-ups in captures, remove this and re-record the set.
  const tiers = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? allTiers.slice(0, 1) : allTiers;
  const climbs: Climb[] = [];
  const seenUuids = new Set<string>();
  const topUpTiers = new Map<string, number>();
  let lastTierRanOut = false;
  let sentOffline = false;
  for (const [tierIndex, tier] of tiers.entries()) {
    const tierTarget = tierIndex === 0 ? target : topUpLimit;
    if (climbs.length >= tierTarget) break;
    let tierRanOut = false;
    try {
      for (let page = 0; climbs.length < tierTarget && page < maxPagesPerTier; page++) {
        if (ctx.isCurrent?.() === false) return { climbs, topUpTiers };
        if (!onlineManager.isOnline()) sentOffline = true;
        const input = buildClimbSearchInput(grade, ctx, page, pageSize, tier);
        const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
        const pageClimbs = response.searchClimbs.climbs;
        for (const climb of pageClimbs) {
          if (seenUuids.has(climb.uuid)) continue;
          seenUuids.add(climb.uuid);
          climbs.push(climb);
          if (tierIndex > 0) topUpTiers.set(climb.uuid, tierIndex);
        }
        if (!response.searchClimbs.hasMore || pageClimbs.length < pageSize) {
          tierRanOut = true;
          break;
        }
      }
    } catch (error) {
      if (tierIndex === 0) throw error;
      break;
    }
    // Each tier holds every climb the ones before it do, so the last one
    // running out means the pool has everything.
    lastTierRanOut = tierRanOut && tierIndex === tiers.length - 1;
  }
  return { climbs, topUpTiers, exhausted: lastTierRanOut && !sentOffline };
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
