import { onlineManager } from '@tanstack/react-query';
import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { PlannedClimbSlot } from '@boardsesh/playlist-generator';
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
import { searchTiers, type ClimbSearchTier } from './workout-search-tiers';

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
 * How Benchmarks only orders a grade: most ascents first. A server from before
 * the NaN fix in `createClimbFilters` (#6232) still answers `onlyBenchmarks` on
 * Kilter with tens of thousands of climbs that are not benchmarks, mostly
 * little-repeated ones, and the quality sort put those first: a block read its
 * page bound of them and found no benchmark, and loosening Min ascents let in
 * more of them, so the pool shrank. Benchmarks are among the most repeated
 * climbs of their grade (on Kilter layout 1 at 40°, 119 of its 122 rank in the
 * top 150 of their grade by ascents and 1 by quality, in the dev database on
 * 2026-10-24), so this order reaches them within the same requests. It also makes a looser Min ascents
 * keep every climb a stricter one found: a looser floor only adds climbs below
 * the ones it already had. With the fixed server every row is a benchmark and
 * a grade holds a few dozen at most, so the order costs nothing there.
 */
const BENCHMARK_SORT = 'ascents';

/**
 * Build the SEARCH_CLIMBS input for a single target grade and search tier:
 * quality-sorted pool, the optional ascent, rating, tall, wide and benchmark
 * filters, and the tier's personal flags. Signed out those flags are never
 * sent (the server ignores them without a user). A filter that is off adds
 * no key, so the default request stays the one the screenshot fixtures
 * recorded. The tier defaults to the first one the filters search.
 *
 * Benchmarks only sorts by ascents instead (`BENCHMARK_SORT`).
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
    // rather than whatever happens to be most-recently published. Benchmarks
    // only reads by ascents (`BENCHMARK_SORT`); off, the request is unchanged.
    sortBy: filters?.onlyBenchmarks ? BENCHMARK_SORT : 'quality',
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

/**
 * Whether a search row is a benchmark: a positive benchmark difficulty, the
 * same test that draws the benchmark ribbon on a row.
 *
 * Benchmarks only checks every row with it, in case the server is one from
 * before the NaN fix (see `BENCHMARK_SORT`), whose `onlyBenchmarks` kept Kilter
 * climbs that come back with no benchmark difficulty.
 */
export function isBenchmarkClimb(climb: Pick<Climb, 'benchmark_difficulty'>): boolean {
  return Number(climb.benchmark_difficulty) > 0;
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
 * Under Benchmarks only a row that is not a benchmark (`isBenchmarkClimb`) is
 * dropped and does not count towards the target, so the fetch reads on to the
 * next page instead. Paging still stops at `maxPagesPerTier`; the ascents
 * order (`BENCHMARK_SORT`) is what keeps benchmarks inside it.
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
  const benchmarksOnly = ctx.filters?.onlyBenchmarks === true;
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
          if (benchmarksOnly && !isBenchmarkClimb(climb)) continue;
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
