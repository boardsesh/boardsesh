import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { GeneratorGradeScale, PlannedClimbSlot, WorkoutStageFilters } from '@boardsesh/playlist-generator';
import { climbToQueueItem } from '../../../lib/climb-to-queue-item';
import { screenshotModeRandom } from '../../../lib/screenshot-mode';
import type { RandomSource } from '../../../lib/seeded-random';
import {
  biasCanSkipSent,
  biasCanSkipTried,
  biasDropsFloors,
  tierAscentStatus,
  type TierAscentStatus,
} from './workout-search-tiers';

/**
 * Pure climb-pool bookkeeping for the live workout preview. No GraphQL, no React
 * — the per-grade fetch is injected as `fetchPool` so this whole module unit
 * tests in node with a fake. The mobile-only GraphQL `fetchGradePool` that backs
 * it in production lives in `select-climbs-for-plan.ts`.
 */

export type PreviewFilters = WorkoutStageFilters;

export type PreviewFetchContext = {
  board: UserBoard;
  /** Gates the climbBias hide/show-attempted filters, which require auth. */
  isAuthenticated: boolean;
  /**
   * Search on the Boardsesh grade, the one the preview rows show, instead of the
   * upstream grade. Off (or absent) leaves the request untouched.
   */
  boardseshGrades?: boolean;
  /**
   * The filters one fetch runs with. `buildPools` and a row refresh set them
   * from the slot they fetch for. Absent → no filtering.
   */
  filters?: PreviewFilters;
  /**
   * False once the build or row refresh this fetch serves has been superseded.
   * The fetch checks it before every request and stops there, so a build the
   * climber has already moved past spends no more of the search budget.
   * Absent → always current.
   */
  isCurrent?: () => boolean;
};

/**
 * The tier of each top-up climb in a pool, by climb uuid: 1 for a climb first
 * found by the second search tier, 2 for the third. A climb with no entry came
 * from the first tier. See `searchTiers` (workout-search-tiers.ts).
 */
export type TopUpTiers = ReadonlyMap<string, number>;

export const NO_TOP_UPS: TopUpTiers = new Map();

/** One grade's candidates: every tier's climbs, the first tier's first. */
export type GradePool = {
  climbs: Climb[];
  /**
   * The climbs a later tier added, which a slot takes only when no climb from an
   * earlier tier is left: under the default filters, the ones you have tried
   * and then the ones you have sent.
   */
  topUpTiers: TopUpTiers;
  /**
   * True when the pool holds every climb the grade has under these filters, so
   * fetching it again, for any demand, would bring back the same climbs. Absent
   * or false when the fetch stopped early, a tier failed, or a request went out
   * offline: such a pool is fetched again when it comes up short.
   */
  exhausted?: boolean;
};

/**
 * Fetch a pool of candidate climbs at a single target grade. `demand` is how
 * many slots will draw from it, so the fetcher can return at least that many
 * when the catalogue has them.
 */
export type FetchGradePool = (grade: number, ctx: PreviewFetchContext, demand: number) => Promise<GradePool>;

/**
 * A plan slot, plus the workout stage it belongs to when it came from a staged
 * plan and the climb filters that stage's climbs are fetched with.
 */
export type PreviewSlot = PlannedClimbSlot & { stageId?: string; filters?: PreviewFilters };

/**
 * One string per distinct set of filters, so equal filters share a pool and
 * different ones never do. `skipSent`, `skipTried` and `onlyBenchmarks` are
 * added only when on, so the default filters keep the signature they had
 * before those existed.
 */
export function filtersSignature(filters: PreviewFilters | undefined): string {
  if (!filters) return 'unfiltered';
  const parts: Array<string | number | boolean> = [
    filters.minAscents,
    filters.minRating,
    filters.onlyTallClimbs,
    filters.onlyWideClimbs,
    filters.climbBias,
  ];
  if (filters.skipSent) parts.push('skipSent');
  if (filters.skipTried) parts.push('skipTried');
  if (filters.onlyBenchmarks) parts.push('benchmarks');
  return parts.join(':');
}

/**
 * The filters a fetch can actually apply. Signed out, climb bias and the skip
 * switches never reach the search (they read your logbook), so bias is set to
 * `any` and `skipSent` and `skipTried` dropped. Signed in, a skip switch the
 * bias rules out is dropped: Skip what I've tried under Attempted or Sent
 * (`biasCanSkipTried`), Skip what I've sent under Sent (`biasCanSkipSent`).
 * Under Sent and Liked (`biasDropsFloors`) min ascents and min rating are set
 * to 0, which the search reads as no floor: a climb you have sent or liked is in
 * the block whatever the crowd made of it. Attempted keeps the block's floors,
 * so its request is the one it always sent. Two blocks that differ only in what
 * got dropped then share one pool instead of fetching the same climbs twice.
 */
export function fetchFilters(
  filters: PreviewFilters | undefined,
  isAuthenticated: boolean,
): PreviewFilters | undefined {
  if (!filters) return filters;
  if (isAuthenticated) {
    const { climbBias } = filters;
    const dropsSkipSent = filters.skipSent === true && !biasCanSkipSent(climbBias);
    const dropsSkipTried = filters.skipTried === true && !biasCanSkipTried(climbBias);
    const dropsFloors = biasDropsFloors(climbBias) && (filters.minAscents !== 0 || filters.minRating !== 0);
    if (!dropsSkipSent && !dropsSkipTried && !dropsFloors) return filters;
    const applicable: PreviewFilters = dropsFloors ? { ...filters, minAscents: 0, minRating: 0 } : { ...filters };
    if (dropsSkipSent) delete applicable.skipSent;
    if (dropsSkipTried) delete applicable.skipTried;
    return applicable;
  }
  if (filters.climbBias === 'any' && !filters.skipSent && !filters.skipTried) return filters;
  const anyoneCanApply: PreviewFilters = { ...filters, climbBias: 'any' };
  delete anyoneCanApply.skipSent;
  delete anyoneCanApply.skipTried;
  return anyoneCanApply;
}

/** The pool a slot draws from: its grade and its filters. */
export function poolKeyForSlot(slot: PreviewSlot): string {
  return `${slot.grade}|${filtersSignature(slot.filters)}`;
}

/**
 * Where a grade that runs short looks next, in places on the grade scale: one
 * easier, one harder, two easier, two harder. Steps walk the scale's order, not
 * the difficulty ids, which are not dense (MoonBoard and Woods skip ids). A
 * borrowed climb keeps every filter of its slot.
 */
export const BORROW_GRADE_STEPS: readonly number[] = [-1, 1, -2, 2];

const NO_GRADES: GeneratorGradeScale = [];

/**
 * The grade `step` places from `grade` on `grades`, or null past either end of
 * the scale or for a grade the scale does not hold.
 */
export function borrowedGrade(grades: GeneratorGradeScale, grade: number, step: number): number | null {
  const position = grades.findIndex((entry) => entry.difficulty_id === grade);
  if (position === -1) return null;
  return grades[position + step]?.difficulty_id ?? null;
}

/**
 * The grade scale a preview borrows along: `grades`, or none in a screenshot
 * capture. Captures replay recorded SearchClimbs answers by their exact
 * variables, and where a grade came back short (Woods, and MoonBoard at the
 * recorded grade) a nearby grade's search, and the stats of the climbs it
 * would show, have no answer and fail the capture. To show borrowed rows in
 * captures, remove this and re-record the set.
 */
export function borrowScaleFor(grades: GeneratorGradeScale): GeneratorGradeScale {
  return process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? NO_GRADES : grades;
}

/** `slot` at each grade it may borrow from, nearest first: every step of `steps`, by default `BORROW_GRADE_STEPS`. */
function borrowSources(
  slot: PreviewSlot,
  grades: GeneratorGradeScale,
  steps: readonly number[] = BORROW_GRADE_STEPS,
): PreviewSlot[] {
  const sources: PreviewSlot[] = [];
  for (const step of steps) {
    const grade = borrowedGrade(grades, slot.grade, step);
    if (grade !== null) sources.push({ ...slot, grade });
  }
  return sources;
}

/**
 * One preview row: the queue item plus the plan slot it fills. `slot.grade` is
 * the grade its climb came from, so `poolKeyForSlot(slot)` names that climb's
 * pool; for a borrowed row `borrowedFrom.plannedGrade` is the grade the plan
 * asked for, the one a refresh tries first.
 */
export type PreviewItem = {
  item: ClimbQueueItem;
  slot: PreviewSlot;
  /**
   * Set when the plan's grade ran short and this climb came from a nearby one
   * (`BORROW_GRADE_STEPS`): the grade the slot was planned at. `slot.grade` is
   * the grade the climb fills in from.
   */
  borrowedFrom?: { plannedGrade: number };
  /**
   * The ascent mark the search that found this climb proves (`tierAscentStatus`):
   * set on a top-up from the "tried, not sent" or the "sent" search. The row
   * draws it while the climb's logbook has not loaded, so a sent top-up never
   * reads as a climb you have not done. Absent when the search proves nothing.
   */
  knownStatus?: TierAscentStatus;
};

/**
 * A preview row for `item` in `plannedSlot`, its climb taken from `source`: the
 * planned slot itself, or the same slot at a nearby grade. Carries the mark the
 * source pool's search proves, and `borrowedFrom` when the grades differ.
 */
function toPreviewItem(
  plannedSlot: PreviewSlot,
  source: PreviewSlot,
  item: ClimbQueueItem,
  poolTopUpTiers: ReadonlyMap<string, TopUpTiers>,
): PreviewItem {
  const topUpTiers = poolTopUpTiers.get(poolKeyForSlot(source)) ?? NO_TOP_UPS;
  const knownStatus = tierAscentStatus(source.filters, tierOf(item.climb.uuid, topUpTiers));
  const preview: PreviewItem = { slot: source, item };
  if (source.grade !== plannedSlot.grade) preview.borrowedFrom = { plannedGrade: plannedSlot.grade };
  if (knownStatus) preview.knownStatus = knownStatus;
  return preview;
}

/** The slot a row was planned for: its own slot, at the planned grade when it borrowed. */
function plannedSlotOf(preview: PreviewItem): PreviewSlot {
  return preview.borrowedFrom ? { ...preview.slot, grade: preview.borrowedFrom.plannedGrade } : preview.slot;
}

export type WorkoutPreviewData = {
  items: PreviewItem[];
  /** Shuffled candidate pool per grade and filters (`poolKeyForSlot`). Mutable cache reused across refreshes. */
  pools: Map<string, Climb[]>;
  /**
   * The demand each pool was last fetched for, so a rebuild can tell whether a
   * cached pool is still big enough to reuse. A pool with no entry is never reused.
   */
  poolDemands?: Map<string, number>;
  /**
   * Each pool's top-up climbs (`GradePool.topUpTiers`), by pool key. A pool with
   * no entry has none: every climb in it came from the first tier.
   */
  poolTopUpTiers?: Map<string, TopUpTiers>;
  /** The pools that hold every climb their grade has (`GradePool.exhausted`), by pool key. */
  exhaustedPoolKeys?: Set<string>;
  /**
   * The pools a row refresh has searched again since this preview was built, by
   * pool key. Searching one a second time would bring back the same climbs, so
   * a refresh never does: tapping a row that has nothing new sends no request.
   */
  refetchedPoolKeys?: Set<string>;
  /** climb.uuid currently shown across ALL rows (refresh never re-picks one). */
  usedUuids: Set<string>;
};

/**
 * Fisher–Yates in place. Randomized across calls so two builds at the same grade
 * differ.
 *
 * `random` is injected so screenshot mode can hand in a seeded generator and get
 * the same order every capture — see `screenshotModeRandom`. Everything else
 * takes the default and stays genuinely random.
 */
export function shuffleInPlace<T>(items: T[], random: RandomSource = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** The tier a climb of a pool came from: 0 for the first. */
function tierOf(climbUuid: string, topUpTiers: TopUpTiers): number {
  return topUpTiers.get(climbUuid) ?? 0;
}

/**
 * `climbs` shuffled within each tier, the first tier first, as a new array. A
 * shuffle then mixes the climbs you have not sent among themselves and never
 * puts a sent one ahead of them. With no top-ups it is one plain shuffle that
 * draws from `random` exactly as `shuffleInPlace` does, so a screenshot capture
 * keeps its seeded order.
 */
export function shuffleByTier(
  climbs: readonly Climb[],
  topUpTiers: TopUpTiers,
  random: RandomSource = Math.random,
): Climb[] {
  if (topUpTiers.size === 0) return shuffleInPlace(climbs.slice(), random);
  const climbsByTier = new Map<number, Climb[]>();
  for (const climb of climbs) {
    const tier = tierOf(climb.uuid, topUpTiers);
    const tierClimbs = climbsByTier.get(tier);
    if (tierClimbs) tierClimbs.push(climb);
    else climbsByTier.set(tier, [climb]);
  }
  return Array.from(climbsByTier)
    .sort(([firstTier], [secondTier]) => firstTier - secondTier)
    .flatMap(([, tierClimbs]) => shuffleInPlace(tierClimbs, random));
}

/** First climb in `pool` whose uuid isn't in `used`, or null. */
export function pickUnused(pool: readonly Climb[], used: ReadonlySet<string>): Climb | null {
  return pool.find((climb) => !used.has(climb.uuid)) ?? null;
}

/**
 * A uniformly random climb in `pool` whose uuid isn't in `used`, or null. Used
 * by refresh so re-rolling the same row reaches across the whole grade pool
 * instead of toggling between the lowest-index climbs `pickUnused` would return.
 * With `topUpTiers` it picks only among the unused climbs of the earliest tier
 * that still has one, so a refresh lands on a sent climb only once every climb
 * you have not sent is on screen.
 */
export function pickRandomUnused(
  pool: readonly Climb[],
  used: ReadonlySet<string>,
  random: RandomSource = Math.random,
  topUpTiers: TopUpTiers = NO_TOP_UPS,
): Climb | null {
  const unused = pool.filter((climb) => !used.has(climb.uuid));
  if (unused.length === 0) return null;
  const bestTier = unused.reduce((lowest, climb) => Math.min(lowest, tierOf(climb.uuid, topUpTiers)), Infinity);
  const candidates = unused.filter((climb) => tierOf(climb.uuid, topUpTiers) === bestTier);
  return candidates[Math.floor(random() * candidates.length)];
}

/**
 * How many slots sit at `grade` across every pool. Each pool at a grade is sized
 * by this total, not by its own slots: two filter sets at one grade mostly return
 * the same top-quality climbs, so a pool sized for its own share would run dry
 * once the other pool's slots had taken the climbs they have in common.
 */
function slotsAtGrade(slots: readonly PreviewSlot[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const slot of slots) counts.set(slot.grade, (counts.get(slot.grade) ?? 0) + 1);
  return counts;
}

/** Pools fetched for an earlier plan, offered back to `buildPoolsReusing`. */
export type PoolCache = {
  pools: ReadonlyMap<string, Climb[]>;
  poolDemands?: ReadonlyMap<string, number>;
  poolTopUpTiers?: ReadonlyMap<string, TopUpTiers>;
  exhaustedPoolKeys?: ReadonlySet<string>;
};

export type BuiltPools = {
  pools: Map<string, Climb[]>;
  poolDemands: Map<string, number>;
  poolTopUpTiers: Map<string, TopUpTiers>;
  exhaustedPoolKeys: Set<string>;
};

/**
 * Fetch one shuffled pool per unique grade and filters in the plan. Round-trips
 * stay proportional to the workout shape, not the climb count: stages with equal
 * filters share a pool per grade, and stages with different filters at one grade
 * each get their own. Each fetch asks for every slot at its grade (`slotsAtGrade`).
 * A pool is shuffled tier by tier (`shuffleByTier`), so walking it in order, as
 * `selectItemsFromPools` does, takes its top-up climbs last.
 *
 * A pool in `cache` under the same key, fetched for at least the demand it needs
 * now, is reused as it is, so changing one block's filters fetches only that
 * block's pools. So is a cached pool that holds every climb its grade has
 * (`GradePool.exhausted`), whatever the demand: a thin grade, a Benchmarks only
 * block or Skip what I've sent come back short by nature, and fetching them
 * again on every edit would spend the search budget for the same climbs. The
 * caller passes a cache only when the board and sign-in are the ones the cache
 * was fetched for.
 */
export async function buildPoolsReusing(
  slots: readonly PreviewSlot[],
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
  cache?: PoolCache,
): Promise<BuiltPools> {
  const demandByGrade = slotsAtGrade(slots);
  const slotByKey = new Map<string, PreviewSlot>();
  for (const slot of slots) {
    const key = poolKeyForSlot(slot);
    if (!slotByKey.has(key)) slotByKey.set(key, slot);
  }
  const built: BuiltPools = {
    pools: new Map(),
    poolDemands: new Map(),
    poolTopUpTiers: new Map(),
    exhaustedPoolKeys: new Set(),
  };
  await Promise.all(
    Array.from(slotByKey, async ([key, slot]) => {
      const demand = demandByGrade.get(slot.grade) ?? 0;
      if (reuseCachedPool(built, key, demand, cache)) return;
      storeFetchedPool(built, key, await fetchPool(slot.grade, { ...ctx, filters: slot.filters }, demand), demand);
    }),
  );
  return built;
}

/**
 * Copies the pool `cache` holds under `key` into `built` when it can stand in
 * for a fetch at `demand`: it holds every climb its grade has, or it was fetched
 * for at least that demand and has as many climbs. False when it cannot.
 */
function reuseCachedPool(built: BuiltPools, key: string, demand: number, cache: PoolCache | undefined): boolean {
  const cachedPool = cache?.pools.get(key);
  if (!cachedPool) return false;
  const cachedDemand = cache?.poolDemands?.get(key);
  const cachedExhausted = cache?.exhaustedPoolKeys?.has(key) === true;
  // Any other pool that came back short (offline, a flaky fetch) is fetched
  // again rather than starving its block until Regenerate.
  const coversDemand = cachedDemand !== undefined && cachedDemand >= demand && cachedPool.length >= demand;
  if (!cachedExhausted && !coversDemand) return false;
  built.pools.set(key, cachedPool);
  built.poolDemands.set(key, cachedDemand ?? demand);
  const cachedTopUpTiers = cache?.poolTopUpTiers?.get(key);
  if (cachedTopUpTiers) built.poolTopUpTiers.set(key, cachedTopUpTiers);
  if (cachedExhausted) built.exhaustedPoolKeys.add(key);
  return true;
}

/** Puts a pool just fetched for `demand` into `built` under `key`, replacing what was there. */
function storeFetchedPool(built: BuiltPools, key: string, fetched: GradePool, demand: number): void {
  // Shuffle here (not in the fetcher) so a refetch-on-refresh reshuffles.
  built.pools.set(key, shuffleByTier(fetched.climbs, fetched.topUpTiers, screenshotModeRandom()));
  built.poolDemands.set(key, demand);
  if (fetched.topUpTiers.size > 0) built.poolTopUpTiers.set(key, fetched.topUpTiers);
  else built.poolTopUpTiers.delete(key);
  if (fetched.exhausted) built.exhaustedPoolKeys.add(key);
  else built.exhaustedPoolKeys.delete(key);
}

/** What the rows a borrow pass plans for will be filled with, as `selectItemsFromPools` takes them. */
export type BorrowOptions = {
  /** Pools an earlier preview fetched, reused under `buildPoolsReusing`'s rule. */
  cache?: PoolCache;
  avoidClimbUuids?: ReadonlySet<string>;
  keptItems?: ReadonlyArray<ClimbQueueItem | undefined>;
};

/**
 * The most nearby-pool searches one build sends. A thin grade reads one page
 * per search tier, up to three under the default filters signed in, so this
 * caps the borrow pass near 18 requests a build against the 120 a minute the
 * search allows. Nearer steps spend it first, a pool reused from the cache
 * costs none of it, and the next rebuild reuses what this one found.
 */
export const MAX_BORROW_SEARCHES_PER_BUILD = 6;

/**
 * Fetches the nearby-grade pools a plan's short slots borrow from, into `built`.
 * Runs after `buildPoolsReusing` and before the `selectItemsFromPools` that
 * fills the rows, with the same avoided climbs and kept rows. One step of
 * `BORROW_GRADE_STEPS` at a time, nearest first, it fills the plan from the
 * pools it has, reaching no further than that step, and for each slot still
 * empty searches the nearest pool it may still grow, with the slot's own
 * filters, sized by every slot planned at that grade or taking climbs from it
 * plus the ones still short. So a slot searches one grade easier before a pool
 * another block already fetched one grade harder, or two away, can fill it, and
 * a pool that blocks on both sides of a grade borrow from grows for both. A nearby
 * grade fills a slot here only with a climb not in `avoidClimbUuids`, so a slot
 * that would fall back on a queued climb there searches the next grade first.
 * A plan that fills at its own grades fetches nothing more, and so does a step
 * whose earlier steps filled it.
 *
 * A nearby pool is searched again only while slots still come up short there
 * and its last search found more climbs; never once it holds every climb its
 * grade has. A pool in `cache` is reused under the same rule as
 * `buildPoolsReusing`, so an edit to another block searches no nearby grade
 * again. At most `MAX_BORROW_SEARCHES_PER_BUILD` searches go out. A nearby
 * search that fails is skipped, never failing the build, and is sent again by
 * the next rebuild, as a short plan pool is. Stops once `ctx.isCurrent`
 * says the build is superseded. An empty `grades` borrows nothing. Returns
 * `built`, the nearby pools added.
 */
export async function borrowForShortSlots(
  slots: readonly PreviewSlot[],
  built: BuiltPools,
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
  grades: GeneratorGradeScale,
  { cache, avoidClimbUuids = NO_AVOIDED_CLIMBS, keptItems = [] }: BorrowOptions = {},
): Promise<BuiltPools> {
  if (grades.length === 0) return built;
  const demandByGrade = slotsAtGrade(slots);
  // The nearby pools this build will not search again: a search failed or found
  // nothing more, or the searches ran out. A read-out pool is in
  // `built.exhaustedPoolKeys` instead.
  const settledKeys = new Set<string>();
  let searchesLeft = MAX_BORROW_SEARCHES_PER_BUILD;
  let stepCount = 1;
  while (stepCount <= BORROW_GRADE_STEPS.length) {
    if (ctx.isCurrent?.() === false) break;
    const borrowSteps = BORROW_GRADE_STEPS.slice(0, stepCount);
    const { items, shortSlots } = fillSlots(slots, built.pools, {
      avoidClimbUuids,
      keptItems,
      poolTopUpTiers: built.poolTopUpTiers,
      grades,
      borrowSteps,
      borrowAvoided: false,
    });
    if (shortSlots.length === 0) break;
    // The rows each pool fills now, by pool key, so a pool searched again is
    // asked for every one of them as well as the slots still short.
    const rowsByPoolKey = new Map<string, number>();
    for (const row of items) {
      const rowPoolKey = poolKeyForSlot(row.slot);
      rowsByPoolKey.set(rowPoolKey, (rowsByPoolKey.get(rowPoolKey) ?? 0) + 1);
    }
    // The short slots each nearby pool would serve, by pool key: for each slot
    // the nearest step whose pool is neither settled nor read out. The fill
    // reached every one of those steps, so the slot found nothing in them: a
    // pool it has is out of free climbs and can only grow.
    const needsByKey = new Map<string, { source: PreviewSlot; count: number }>();
    for (const slot of shortSlots) {
      const source = borrowSources(slot, grades, borrowSteps).find((candidate) => {
        const candidateKey = poolKeyForSlot(candidate);
        return !settledKeys.has(candidateKey) && !built.exhaustedPoolKeys.has(candidateKey);
      });
      if (!source) continue;
      const key = poolKeyForSlot(source);
      const need = needsByKey.get(key);
      if (need) need.count++;
      else needsByKey.set(key, { source, count: 1 });
    }
    // Every step so far is settled for every short slot: reach one further.
    if (needsByKey.size === 0) {
      stepCount++;
      continue;
    }
    const searches: Array<Promise<void>> = [];
    for (const [key, { source, count }] of needsByKey) {
      // Every slot planned at the grade or already taking from the pool, at
      // least what it was last fetched for, and the slots still short there.
      const demand =
        Math.max(demandByGrade.get(source.grade) ?? 0, rowsByPoolKey.get(key) ?? 0, built.poolDemands.get(key) ?? 0) +
        count;
      // A pool `built` already has gave these slots nothing (the fill above
      // reached it) and was weighed against the cache when it was built, so
      // only a fetch can add to it.
      if (!built.pools.has(key) && reuseCachedPool(built, key, demand, cache)) continue;
      // Settled when the cap stops its search: with no search left, the slot
      // may take a pool the build already has one step further out rather than
      // stay empty, and the next rebuild searches this one.
      if (searchesLeft === 0) {
        settledKeys.add(key);
        continue;
      }
      searchesLeft--;
      searches.push(
        searchNearbyPool(built, key, source, demand, ctx, fetchPool).then((grew) => {
          if (!grew) settledKeys.add(key);
        }),
      );
    }
    await Promise.all(searches);
    // `stepCount` stays on purpose: the next pass fills again with the pools
    // just found at this reach, and moves one step further (the `continue`
    // above) only once every short slot's steps so far are settled, so while
    // searches are left no slot takes a further grade before a nearer one.
  }
  return built;
}

/**
 * Fetches one nearby pool into `built` for `demand`. True when it came back
 * with more climbs than `built` held for it. A search that fails, or finds no
 * more, leaves the pool `built` has as it was (marking it read out when the
 * search says so), so a pool never shrinks under the rows it already fills.
 */
async function searchNearbyPool(
  built: BuiltPools,
  key: string,
  source: PreviewSlot,
  demand: number,
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
): Promise<boolean> {
  let fetched: GradePool;
  try {
    fetched = await fetchPool(source.grade, { ...ctx, filters: source.filters }, demand);
  } catch {
    // Borrowing only adds to a plan that already built: a nearby search that
    // fails leaves its slots for the next step, or short.
    return false;
  }
  const heldClimbs = built.pools.get(key);
  if (fetched.climbs.length <= (heldClimbs?.length ?? 0)) {
    if (!heldClimbs) storeFetchedPool(built, key, fetched, demand);
    else if (fetched.exhausted) built.exhaustedPoolKeys.add(key);
    return false;
  }
  storeFetchedPool(built, key, fetched, demand);
  return true;
}

/** `buildPoolsReusing` with nothing cached, for callers that only need the pools. */
export async function buildPools(
  slots: readonly PreviewSlot[],
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
): Promise<Map<string, Climb[]>> {
  return (await buildPoolsReusing(slots, ctx, fetchPool)).pools;
}

/**
 * Every pool reshuffled into a new map, for a whole-preview shuffle. The fetched
 * climbs are reused (no network) and the caller re-runs `selectItemsFromPools`
 * over the same plan, so the grades and sections stay put and only the climbs
 * change. Each pool is shuffled within its tiers, so top-ups stay last.
 */
export function reshufflePools(
  pools: ReadonlyMap<string, Climb[]>,
  poolTopUpTiers: ReadonlyMap<string, TopUpTiers> | undefined,
  random: RandomSource = Math.random,
): Map<string, Climb[]> {
  return new Map(
    Array.from(pools, ([key, climbs]) => [key, shuffleByTier(climbs, poolTopUpTiers?.get(key) ?? NO_TOP_UPS, random)]),
  );
}

export const NO_AVOIDED_CLIMBS: ReadonlySet<string> = new Set();

const NO_POOL_TOP_UPS: ReadonlyMap<string, TopUpTiers> = new Map();

/**
 * Walk each slot's shuffled pool, skipping climbs already chosen in ANY pool,
 * so one climb never fills two slots even when two filter sets both return it.
 * Short or empty pools skip the slot so the caller can report the shortfall as
 * `failedCount`, matching the web generator's behavior. Each pool is walked in
 * order, and the pools are kept tier by tier (`shuffleByTier`), so a slot takes
 * a top-up climb only once its pool has no earlier-tier climb left.
 *
 * `avoidClimbUuids` are climbs to pass over when the pool has others, such as
 * the climbs already in a live session's queue when a block is added mid-session.
 * They are a preference, not a filter: when only avoided climbs are left at the
 * slot's own grade, one of them fills the slot before it borrows. At a nearby
 * grade one is the last resort, taken only once no nearby grade has a climb
 * that is not avoided, and never leaving the slot empty while one is there.
 *
 * `keptItems[i]`, when set, is the row slot `i` showed before a rebuild. It is
 * kept as it is (same queue-item uuid, same climb) while its climb is still in
 * the slot's pool, or in the pool it borrowed from, unused and not avoided, so a
 * block the climber did not touch keeps its climbs when another block changes.
 * Kept rows are placed first, so a changed block never takes one of their climbs.
 *
 * `poolTopUpTiers` (`BuiltPools.poolTopUpTiers`) gives each row the mark its
 * climb's search proves (`PreviewItem.knownStatus`). Left out, no row gets one.
 *
 * `grades` is the board's grade scale. Given, a slot whose own grade has no
 * free climb left borrows one from a nearby grade (`BORROW_GRADE_STEPS`) from
 * the pools at hand, with its own filters, and its row says so
 * (`PreviewItem.borrowedFrom`). Every short slot takes the nearest grade before
 * any takes one further away. `borrowForShortSlots` fetches those pools first.
 * Left out, a short slot stays empty.
 */
export function selectItemsFromPools(
  slots: readonly PreviewSlot[],
  pools: ReadonlyMap<string, Climb[]>,
  avoidClimbUuids: ReadonlySet<string> = NO_AVOIDED_CLIMBS,
  keptItems: ReadonlyArray<ClimbQueueItem | undefined> = [],
  poolTopUpTiers: ReadonlyMap<string, TopUpTiers> = NO_POOL_TOP_UPS,
  grades: GeneratorGradeScale = NO_GRADES,
): { items: PreviewItem[]; usedUuids: Set<string> } {
  const { items, usedUuids } = fillSlots(slots, pools, {
    avoidClimbUuids,
    keptItems,
    poolTopUpTiers,
    grades,
    borrowSteps: BORROW_GRADE_STEPS,
    borrowAvoided: true,
  });
  return { items, usedUuids };
}

type FillOptions = {
  avoidClimbUuids: ReadonlySet<string>;
  keptItems: ReadonlyArray<ClimbQueueItem | undefined>;
  poolTopUpTiers: ReadonlyMap<string, TopUpTiers>;
  grades: GeneratorGradeScale;
  /**
   * The borrow steps a slot may take a climb from, nearest first: every one for
   * the rows, or the ones the borrow pass has reached so far.
   */
  borrowSteps: readonly number[];
  /** Whether a slot no nearby grade has a fresh climb for may then take an avoided one there. */
  borrowAvoided: boolean;
};

type FilledSlots = {
  /** One row per slot that found a climb, in plan order. */
  items: PreviewItem[];
  usedUuids: Set<string>;
  /** The slots that found none, in plan order. */
  shortSlots: PreviewSlot[];
};

/** One pass of `fillSlots`: where each empty slot looks, and whether an avoided climb there will do. */
type FillPass = { sourceFor: (slot: PreviewSlot) => PreviewSlot | null; takesAvoided: boolean };

/** `selectItemsFromPools`, reaching only `borrowSteps`, and also naming the slots left empty. */
function fillSlots(
  slots: readonly PreviewSlot[],
  pools: ReadonlyMap<string, Climb[]>,
  { avoidClimbUuids, keptItems, poolTopUpTiers, grades, borrowSteps, borrowAvoided }: FillOptions,
): FilledSlots {
  const usedUuids = new Set<string>();
  const rowBySlotPosition = new Map<number, PreviewItem>();
  slots.forEach((slot, position) => {
    const kept = keptItems[position];
    if (!kept || usedUuids.has(kept.climb.uuid) || avoidClimbUuids.has(kept.climb.uuid)) return;
    const source = [slot, ...borrowSources(slot, grades)].find((candidate) =>
      (pools.get(poolKeyForSlot(candidate)) ?? []).some((climb) => climb.uuid === kept.climb.uuid),
    );
    if (!source) return;
    usedUuids.add(kept.climb.uuid);
    rowBySlotPosition.set(position, toPreviewItem(slot, source, kept, poolTopUpTiers));
  });
  // Every slot's own grade first, where an avoided climb still beats borrowing.
  // Then one borrow step at a time across all the slots still empty, climbs
  // that are not avoided only, and last the same steps again for an avoided one.
  const nearby =
    (step: number) =>
    (slot: PreviewSlot): PreviewSlot | null => {
      const grade = borrowedGrade(grades, slot.grade, step);
      return grade === null ? null : { ...slot, grade };
    };
  const passes: FillPass[] = [
    { sourceFor: (slot) => slot, takesAvoided: true },
    ...borrowSteps.map((step) => ({ sourceFor: nearby(step), takesAvoided: false })),
    ...(borrowAvoided && avoidClimbUuids.size > 0
      ? borrowSteps.map((step) => ({ sourceFor: nearby(step), takesAvoided: true }))
      : []),
  ];
  for (const { sourceFor, takesAvoided } of passes) {
    slots.forEach((slot, position) => {
      if (rowBySlotPosition.has(position)) return;
      const source = sourceFor(slot);
      if (!source) return;
      const pool = pools.get(poolKeyForSlot(source)) ?? [];
      const next =
        pool.find((climb) => !usedUuids.has(climb.uuid) && !avoidClimbUuids.has(climb.uuid)) ??
        (takesAvoided ? pickUnused(pool, usedUuids) : null);
      if (!next) return;
      usedUuids.add(next.uuid);
      rowBySlotPosition.set(
        position,
        toPreviewItem(slot, source, climbToQueueItem(next, { suggested: true }), poolTopUpTiers),
      );
    });
  }
  const items: PreviewItem[] = [];
  const shortSlots: PreviewSlot[] = [];
  slots.forEach((slot, position) => {
    const row = rowBySlotPosition.get(position);
    if (row) items.push(row);
    else shortSlots.push(slot);
  });
  return { items, usedUuids, shortSlots };
}

export type RefreshSlotResult = {
  state: WorkoutPreviewData;
  changed: boolean;
  /**
   * True when the row stays as it was because every climb that could fill it is
   * already on another row, or it is the only one. `state` then carries the
   * pools the refresh searched, so the next tap does not search them again.
   */
  nothingNew?: boolean;
};

/**
 * Swap a single preview row for a different climb in its slot, with the slot's
 * filters, never one another row shows. The row's planned grade comes first, a
 * borrowed row's included: a random unused climb from the cached pool's
 * earliest tier that has one (no network), so repeated refreshes of one row keep
 * re-rolling across the whole pool rather than toggling between two climbs;
 * then one refetch + reshuffle of that pool when the cache has no unused climb
 * left, unless the pool already holds every climb its grade has or a refresh
 * already searched it again (`refetchedPoolKeys`). With `grades`,
 * a planned grade with nothing left then borrows from the nearby grades in
 * `BORROW_GRADE_STEPS` order, each the same way: its cached pool, then one
 * fetch. When none of them has a climb no row shows, the row keeps its climb
 * (and its caption) and the result says `nothingNew`. Keeps the queue-item uuid
 * (swaps `.climb`) so the row keeps its identity and highlight — mirroring
 * DELTA_REPLACE_QUEUE_ITEM.
 *
 * `avoidClimbUuids` is the same preference `selectItemsFromPools` takes: the
 * refresh passes over those climbs while the pool has others. At the planned
 * grade it falls back to one of them before borrowing; at a nearby grade only
 * once no nearby grade has another climb.
 */
export async function refreshSlotInState(
  state: WorkoutPreviewData,
  targetUuid: string,
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
  avoidClimbUuids: ReadonlySet<string> = NO_AVOIDED_CLIMBS,
  grades: GeneratorGradeScale = NO_GRADES,
): Promise<RefreshSlotResult> {
  const index = state.items.findIndex((preview) => preview.item.uuid === targetUuid);
  if (index === -1) return { state, changed: false }; // row gone (e.g. regenerated under a stale tap)

  const current = state.items[index];
  const plannedSlot = plannedSlotOf(current);

  const { pools } = state;
  let poolTopUpTiers = state.poolTopUpTiers;
  let exhaustedPoolKeys = state.exhaustedPoolKeys;
  let refetchedPoolKeys = state.refetchedPoolKeys;
  // Exclude every climb currently shown (including this row's own) so the refresh
  // lands on a genuinely different climb that isn't already on screen elsewhere.
  // Avoided climbs only if nothing else is left; null means nothing unused at all.
  // Within either, the earliest tier left wins, so a sent climb comes up last.
  const usedOrAvoided = avoidClimbUuids.size > 0 ? new Set([...state.usedUuids, ...avoidClimbUuids]) : state.usedUuids;
  const pickFresh = (pool: readonly Climb[], topUpTiers: TopUpTiers): Climb | null =>
    pickRandomUnused(pool, usedOrAvoided, screenshotModeRandom(), topUpTiers);
  const pickAvoided = (pool: readonly Climb[], topUpTiers: TopUpTiers): Climb | null =>
    usedOrAvoided === state.usedUuids
      ? null
      : pickRandomUnused(pool, state.usedUuids, screenshotModeRandom(), topUpTiers);
  // At the planned grade an avoided climb still beats borrowing.
  const pickPreferred = (pool: readonly Climb[], topUpTiers: TopUpTiers): Climb | null =>
    pickFresh(pool, topUpTiers) ?? pickAvoided(pool, topUpTiers);
  const topUpTiersOf = (poolKey: string): TopUpTiers => poolTopUpTiers?.get(poolKey) ?? NO_TOP_UPS;

  const nearbySources = borrowSources(plannedSlot, grades);
  let picked: { climb: Climb; source: PreviewSlot } | null = null;
  for (const source of [plannedSlot, ...nearbySources]) {
    const pick = source === plannedSlot ? pickPreferred : pickFresh;
    const poolKey = poolKeyForSlot(source);
    const cachedPool = pools.get(poolKey);
    let climb = cachedPool ? pick(cachedPool, topUpTiersOf(poolKey)) : null;
    // Nothing unused in the cache → refetch + reshuffle this pool once, unless
    // it already holds every climb its grade has, or an earlier refresh already
    // searched it again: either way it would come back the same.
    if (!climb && exhaustedPoolKeys?.has(poolKey) !== true && refetchedPoolKeys?.has(poolKey) !== true) {
      // Ask for one more than every row at this grade, in every pool: the other
      // pools' rows may hold the same climbs, so the refetch has to reach past them.
      const rowsAtGrade = state.items.filter((preview) => preview.slot.grade === source.grade).length;
      const refetched = await fetchPool(source.grade, { ...ctx, filters: source.filters }, rowsAtGrade + 1);
      // Superseded while it fetched: its pool may be cut short, and the maps below
      // are shared with the state a newer build reads its cache from.
      if (ctx.isCurrent?.() === false) return { state, changed: false };
      const refreshedPool = shuffleByTier(refetched.climbs, refetched.topUpTiers, screenshotModeRandom());
      pools.set(poolKey, refreshedPool);
      // Every state from buildPoolsReusing carries poolDemands. Without it the
      // next rebuild sees no entry and refetches this pool, which is safe.
      state.poolDemands?.set(poolKey, rowsAtGrade + 1);
      poolTopUpTiers = new Map(poolTopUpTiers);
      if (refetched.topUpTiers.size > 0) poolTopUpTiers.set(poolKey, refetched.topUpTiers);
      else poolTopUpTiers.delete(poolKey);
      exhaustedPoolKeys = new Set(exhaustedPoolKeys);
      if (refetched.exhausted) exhaustedPoolKeys.add(poolKey);
      else exhaustedPoolKeys.delete(poolKey);
      refetchedPoolKeys = new Set(refetchedPoolKeys).add(poolKey);
      climb = pick(refreshedPool, refetched.topUpTiers);
    }
    if (climb) {
      picked = { climb, source };
      break;
    }
  }

  // No nearby grade has a climb that is not avoided: an avoided one there, from
  // the pools just searched, nearest first.
  if (!picked) {
    for (const source of nearbySources) {
      const poolKey = poolKeyForSlot(source);
      const pool = pools.get(poolKey);
      const climb = pool ? pickAvoided(pool, topUpTiersOf(poolKey)) : null;
      if (climb) {
        picked = { climb, source };
        break;
      }
    }
  }

  // Every climb that fits this row, at its grade and at every grade it may
  // borrow from, is on screen already. Showing one twice would leave Start
  // queueing it twice, so the row keeps its climb and its caption.
  if (!picked) {
    return {
      state: { ...state, poolTopUpTiers, exhaustedPoolKeys, refetchedPoolKeys },
      changed: false,
      nothingNew: true,
    };
  }

  // Keep the queue-item uuid (swap `.climb` only); recompute usedUuids from the
  // items so the invariant holds even across pre-existing short-pool repeats.
  const items = state.items.slice();
  items[index] = toPreviewItem(
    plannedSlot,
    picked.source,
    climbToQueueItem(picked.climb, { uuid: current.item.uuid, suggested: true }),
    poolTopUpTiers ?? NO_POOL_TOP_UPS,
  );
  const usedUuids = new Set(items.map((preview) => preview.item.climb.uuid));

  return {
    state: {
      items,
      pools,
      usedUuids,
      poolDemands: state.poolDemands,
      poolTopUpTiers,
      exhaustedPoolKeys,
      refetchedPoolKeys,
    },
    changed: true,
  };
}
