import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { GeneratorOptions, PlannedClimbSlot } from '@boardsesh/playlist-generator';
import { climbToQueueItem } from '../../../lib/climb-to-queue-item';

/**
 * Pure climb-pool bookkeeping for the live workout preview. No GraphQL, no React
 * — the per-grade fetch is injected as `fetchPool` so this whole module unit
 * tests in node with a fake. The mobile-only GraphQL `fetchGradePool` that backs
 * it in production lives in `select-climbs-for-plan.ts`.
 */

export type PreviewFilters = Pick<
  GeneratorOptions,
  'minAscents' | 'minRating' | 'onlyTallClimbs' | 'onlyWideClimbs' | 'climbBias'
>;

export type PreviewFetchContext = {
  board: UserBoard;
  /** Gates the climbBias hide/show-attempted filters, which require auth. */
  isAuthenticated: boolean;
  /** Filters that survived the generator UI. Absent → no filtering. */
  filters?: PreviewFilters;
};

/** Fetch a pool of candidate climbs at a single target grade. */
export type FetchGradePool = (grade: number, ctx: PreviewFetchContext) => Promise<Climb[]>;

/** One preview row: the queue item plus the plan slot it fills (slot.grade is the refresh key). */
export type PreviewItem = {
  item: ClimbQueueItem;
  slot: PlannedClimbSlot;
};

export type WorkoutPreviewData = {
  items: PreviewItem[];
  /** Shuffled candidate pool per grade. Mutable cache reused across refreshes. */
  pools: Map<number, Climb[]>;
  /** climb.uuid currently shown across ALL rows (refresh never re-picks one). */
  usedUuids: Set<string>;
};

/** Fisher–Yates in place. Randomized across calls so two builds at the same grade differ. */
export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** First climb in `pool` whose uuid isn't in `used`, or null. */
export function pickUnused(pool: readonly Climb[], used: ReadonlySet<string>): Climb | null {
  return pool.find((climb) => !used.has(climb.uuid)) ?? null;
}

/**
 * A uniformly random climb in `pool` whose uuid isn't in `used`, or null. Used
 * by refresh so re-rolling the same row reaches across the whole grade pool
 * instead of toggling between the lowest-index climbs `pickUnused` would return.
 */
export function pickRandomUnused(pool: readonly Climb[], used: ReadonlySet<string>): Climb | null {
  const candidates = pool.filter((climb) => !used.has(climb.uuid));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Fetch one shuffled pool per unique grade in the plan. Round-trips stay
 * proportional to the workout shape (unique grades), not the climb count.
 */
export async function buildPools(
  slots: readonly PlannedClimbSlot[],
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
): Promise<Map<number, Climb[]>> {
  const grades = Array.from(new Set(slots.map((slot) => slot.grade)));
  const pools = new Map<number, Climb[]>();
  await Promise.all(
    grades.map(async (grade) => {
      const climbs = await fetchPool(grade, ctx);
      // Shuffle here (not in the fetcher) so a refetch-on-refresh reshuffles.
      pools.set(grade, shuffleInPlace(climbs.slice()));
    }),
  );
  return pools;
}

/**
 * Walk each slot's shuffled pool, skipping climbs already chosen. Short or
 * empty pools skip the slot so the caller can report the shortfall as
 * `failedCount`, matching the web generator's behavior.
 */
export function selectItemsFromPools(
  slots: readonly PlannedClimbSlot[],
  pools: ReadonlyMap<number, Climb[]>,
): { items: PreviewItem[]; usedUuids: Set<string> } {
  const items: PreviewItem[] = [];
  const usedUuids = new Set<string>();
  for (const slot of slots) {
    const pool = pools.get(slot.grade) ?? [];
    const next = pickUnused(pool, usedUuids);
    if (!next) continue;
    usedUuids.add(next.uuid);
    items.push({ slot, item: climbToQueueItem(next, { suggested: true }) });
  }
  return { items, usedUuids };
}

export type RefreshSlotResult = { state: WorkoutPreviewData; changed: boolean };

/**
 * Swap a single preview row for a different climb at the same grade. Picks a
 * random unused climb from the cached pool (no network) so repeated refreshes of
 * one row keep re-rolling across the whole pool rather than toggling between two
 * climbs; refetches+reshuffles that grade once if the cache is exhausted of
 * unused climbs; allows a differing repeat only as a last resort. Keeps the
 * queue-item uuid (swaps `.climb`) so the row keeps its identity and highlight —
 * mirroring DELTA_REPLACE_QUEUE_ITEM.
 */
export async function refreshSlotInState(
  state: WorkoutPreviewData,
  targetUuid: string,
  ctx: PreviewFetchContext,
  fetchPool: FetchGradePool,
): Promise<RefreshSlotResult> {
  const index = state.items.findIndex((preview) => preview.item.uuid === targetUuid);
  if (index === -1) return { state, changed: false }; // row gone (e.g. regenerated under a stale tap)

  const current = state.items[index];
  const { grade } = current.slot;
  const oldClimbUuid = current.item.climb.uuid;

  const { pools } = state;
  const cachedPool = pools.get(grade) ?? [];
  // Exclude every climb currently shown (including this row's own) so the refresh
  // lands on a genuinely different climb that isn't already on screen elsewhere.
  let nextClimb = pickRandomUnused(cachedPool, state.usedUuids);
  let refreshedPool: Climb[] | null = null;

  // 1) Cache exhausted of unused climbs → refetch + reshuffle this grade once.
  if (!nextClimb) {
    refreshedPool = shuffleInPlace((await fetchPool(grade, ctx)).slice());
    pools.set(grade, refreshedPool);
    nextClimb = pickRandomUnused(refreshedPool, state.usedUuids);
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
  items[index] = {
    slot: current.slot,
    item: climbToQueueItem(nextClimb, { uuid: current.item.uuid, suggested: true }),
  };
  const usedUuids = new Set(items.map((preview) => preview.item.climb.uuid));

  return { state: { items, pools, usedUuids }, changed: true };
}
