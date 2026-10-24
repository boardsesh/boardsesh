import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { PlannedClimbSlot, WorkoutStageFilters } from '@boardsesh/playlist-generator';
import { climbToQueueItem } from '../../../lib/climb-to-queue-item';
import { screenshotModeRandom } from '../../../lib/screenshot-mode';
import type { RandomSource } from '../../../lib/seeded-random';
import { biasCanSkipTried, tierAscentStatus, type TierAscentStatus } from './workout-search-tiers';

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
 * `any` and `skipSent` and `skipTried` dropped. Under the Attempted bias Skip
 * what I've tried cannot apply (`biasCanSkipTried`) and is dropped too. Two
 * blocks that differ only in what got dropped then share one pool instead of
 * fetching the same climbs twice.
 */
export function fetchFilters(
  filters: PreviewFilters | undefined,
  isAuthenticated: boolean,
): PreviewFilters | undefined {
  if (!filters) return filters;
  if (isAuthenticated) {
    if (!filters.skipTried || biasCanSkipTried(filters.climbBias)) return filters;
    const applicable: PreviewFilters = { ...filters };
    delete applicable.skipTried;
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

/** One preview row: the queue item plus the plan slot it fills (slot.grade is the refresh key). */
export type PreviewItem = {
  item: ClimbQueueItem;
  slot: PreviewSlot;
  /**
   * The ascent mark the search that found this climb proves (`tierAscentStatus`):
   * set on a top-up from the "tried, not sent" or the "sent" search. The row
   * draws it while the climb's logbook has not loaded, so a sent top-up never
   * reads as a climb you have not done. Absent when the search proves nothing.
   */
  knownStatus?: TierAscentStatus;
};

/** A preview row for `item` in `slot`, with the mark its pool's search proves. */
function toPreviewItem(slot: PreviewSlot, item: ClimbQueueItem, topUpTiers: TopUpTiers): PreviewItem {
  const knownStatus = tierAscentStatus(slot.filters, tierOf(item.climb.uuid, topUpTiers));
  return knownStatus ? { slot, item, knownStatus } : { slot, item };
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
  const pools = new Map<string, Climb[]>();
  const poolDemands = new Map<string, number>();
  const poolTopUpTiers = new Map<string, TopUpTiers>();
  const exhaustedPoolKeys = new Set<string>();
  await Promise.all(
    Array.from(slotByKey, async ([key, slot]) => {
      const demand = demandByGrade.get(slot.grade) ?? 0;
      const cachedPool = cache?.pools.get(key);
      const cachedDemand = cache?.poolDemands?.get(key);
      const cachedExhausted = cache?.exhaustedPoolKeys?.has(key) === true;
      // Any other pool that came back short (offline, a flaky fetch) is fetched
      // again rather than starving its block until Regenerate.
      const coversDemand =
        cachedPool !== undefined && cachedDemand !== undefined && cachedDemand >= demand && cachedPool.length >= demand;
      if (cachedPool && (cachedExhausted || coversDemand)) {
        pools.set(key, cachedPool);
        poolDemands.set(key, cachedDemand ?? demand);
        const cachedTopUpTiers = cache?.poolTopUpTiers?.get(key);
        if (cachedTopUpTiers) poolTopUpTiers.set(key, cachedTopUpTiers);
        if (cachedExhausted) exhaustedPoolKeys.add(key);
        return;
      }
      const { climbs, topUpTiers, exhausted } = await fetchPool(slot.grade, { ...ctx, filters: slot.filters }, demand);
      // Shuffle here (not in the fetcher) so a refetch-on-refresh reshuffles.
      pools.set(key, shuffleByTier(climbs, topUpTiers, screenshotModeRandom()));
      poolDemands.set(key, demand);
      if (topUpTiers.size > 0) poolTopUpTiers.set(key, topUpTiers);
      if (exhausted) exhaustedPoolKeys.add(key);
    }),
  );
  return { pools, poolDemands, poolTopUpTiers, exhaustedPoolKeys };
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
 * They are a preference, not a filter: when only avoided climbs are left at a
 * grade, one of them still fills the slot rather than leave it empty.
 *
 * `keptItems[i]`, when set, is the row slot `i` showed before a rebuild. It is
 * kept as it is (same queue-item uuid, same climb) while its climb is still in
 * the slot's pool, unused and not avoided, so a block the climber did not touch
 * keeps its climbs when another block changes. Kept rows are placed first, so a
 * changed block never takes one of their climbs.
 *
 * `poolTopUpTiers` (`BuiltPools.poolTopUpTiers`) gives each row the mark its
 * climb's search proves (`PreviewItem.knownStatus`). Left out, no row gets one.
 */
export function selectItemsFromPools(
  slots: readonly PreviewSlot[],
  pools: ReadonlyMap<string, Climb[]>,
  avoidClimbUuids: ReadonlySet<string> = NO_AVOIDED_CLIMBS,
  keptItems: ReadonlyArray<ClimbQueueItem | undefined> = [],
  poolTopUpTiers: ReadonlyMap<string, TopUpTiers> = NO_POOL_TOP_UPS,
): { items: PreviewItem[]; usedUuids: Set<string> } {
  const usedUuids = new Set<string>();
  const keptBySlot = new Map<number, ClimbQueueItem>();
  slots.forEach((slot, position) => {
    const kept = keptItems[position];
    if (!kept || usedUuids.has(kept.climb.uuid) || avoidClimbUuids.has(kept.climb.uuid)) return;
    const pool = pools.get(poolKeyForSlot(slot)) ?? [];
    if (!pool.some((climb) => climb.uuid === kept.climb.uuid)) return;
    usedUuids.add(kept.climb.uuid);
    keptBySlot.set(position, kept);
  });
  const items: PreviewItem[] = [];
  for (const [position, slot] of slots.entries()) {
    const poolKey = poolKeyForSlot(slot);
    const topUpTiers = poolTopUpTiers.get(poolKey) ?? NO_TOP_UPS;
    const kept = keptBySlot.get(position);
    if (kept) {
      items.push(toPreviewItem(slot, kept, topUpTiers));
      continue;
    }
    const pool = pools.get(poolKey) ?? [];
    const next =
      pool.find((climb) => !usedUuids.has(climb.uuid) && !avoidClimbUuids.has(climb.uuid)) ??
      pickUnused(pool, usedUuids);
    if (!next) continue;
    usedUuids.add(next.uuid);
    items.push(toPreviewItem(slot, climbToQueueItem(next, { suggested: true }), topUpTiers));
  }
  return { items, usedUuids };
}

export type RefreshSlotResult = { state: WorkoutPreviewData; changed: boolean };

/**
 * Swap a single preview row for a different climb at the same grade and filters. Picks a
 * random unused climb from the cached pool's earliest tier that has one (no network) so repeated refreshes of
 * one row keep re-rolling across the whole pool rather than toggling between two
 * climbs; refetches+reshuffles that grade once if the cache is exhausted of
 * unused climbs; allows a differing repeat only as a last resort. Keeps the
 * queue-item uuid (swaps `.climb`) so the row keeps its identity and highlight —
 * mirroring DELTA_REPLACE_QUEUE_ITEM.
 *
 * `avoidClimbUuids` is the same preference `selectItemsFromPools` takes: the
 * refresh passes over those climbs while the pool has others, and falls back to
 * one of them before calling the pool exhausted.
 */
export async function refreshSlotInState(
  state: WorkoutPreviewData,
  targetUuid: string,
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
  avoidClimbUuids: ReadonlySet<string> = NO_AVOIDED_CLIMBS,
): Promise<RefreshSlotResult> {
  const index = state.items.findIndex((preview) => preview.item.uuid === targetUuid);
  if (index === -1) return { state, changed: false }; // row gone (e.g. regenerated under a stale tap)

  const current = state.items[index];
  const { grade, filters } = current.slot;
  const poolKey = poolKeyForSlot(current.slot);
  const oldClimbUuid = current.item.climb.uuid;

  const { pools } = state;
  const cachedPool = pools.get(poolKey) ?? [];
  let poolTopUpTiers = state.poolTopUpTiers;
  let exhaustedPoolKeys = state.exhaustedPoolKeys;
  // Exclude every climb currently shown (including this row's own) so the refresh
  // lands on a genuinely different climb that isn't already on screen elsewhere.
  // Avoided climbs only if nothing else is left; null means nothing unused at all.
  // Within either, the earliest tier left wins, so a sent climb comes up last.
  const usedOrAvoided = avoidClimbUuids.size > 0 ? new Set([...state.usedUuids, ...avoidClimbUuids]) : state.usedUuids;
  const pickPreferred = (pool: readonly Climb[], topUpTiers: TopUpTiers): Climb | null =>
    pickRandomUnused(pool, usedOrAvoided, screenshotModeRandom(), topUpTiers) ??
    (usedOrAvoided === state.usedUuids
      ? null
      : pickRandomUnused(pool, state.usedUuids, screenshotModeRandom(), topUpTiers));
  let nextClimb = pickPreferred(cachedPool, poolTopUpTiers?.get(poolKey) ?? NO_TOP_UPS);
  let refreshedPool: Climb[] | null = null;

  // 1) Cache exhausted of unused climbs → refetch + reshuffle this pool once.
  if (!nextClimb) {
    // Ask for one more than every row at this grade, in every pool: the other
    // pools' rows may hold the same climbs, so the refetch has to reach past them.
    const rowsAtGrade = state.items.filter((preview) => preview.slot.grade === grade).length;
    const refetched = await fetchPool(grade, { ...ctx, filters }, rowsAtGrade + 1);
    // Superseded while it fetched: its pool may be cut short, and the maps below
    // are shared with the state a newer build reads its cache from.
    if (ctx.isCurrent?.() === false) return { state, changed: false };
    refreshedPool = shuffleByTier(refetched.climbs, refetched.topUpTiers, screenshotModeRandom());
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
    nextClimb = pickPreferred(refreshedPool, refetched.topUpTiers);
  }

  // 2) Tiny catalog: everything at this grade is already shown somewhere. Accept
  //    a repeat as long as it at least differs from THIS row's current climb.
  if (!nextClimb) {
    const source = refreshedPool ?? cachedPool;
    nextClimb = source.find((climb) => climb.uuid !== oldClimbUuid) ?? null;
    if (!nextClimb) return { state, changed: false }; // only this climb exists → nothing to swap to
  }

  // Keep the queue-item uuid (swap `.climb` only); recompute usedUuids from the
  // items so the invariant holds even across pre-existing short-pool repeats.
  const items = state.items.slice();
  items[index] = toPreviewItem(
    current.slot,
    climbToQueueItem(nextClimb, { uuid: current.item.uuid, suggested: true }),
    poolTopUpTiers?.get(poolKey) ?? NO_TOP_UPS,
  );
  const usedUuids = new Set(items.map((preview) => preview.item.climb.uuid));

  return {
    state: { items, pools, usedUuids, poolDemands: state.poolDemands, poolTopUpTiers, exhaustedPoolKeys },
    changed: true,
  };
}
