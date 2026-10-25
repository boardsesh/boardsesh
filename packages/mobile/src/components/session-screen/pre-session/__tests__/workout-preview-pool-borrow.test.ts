// Borrowing from a nearby grade (#6232): a slot whose grade has no climb left
// takes one from the grade next to it, nearest first, with its own filters,
// never a climb another row holds, and says which grade it fills in for. With
// top-ups a pool is rarely short under the default filters, so most cases here
// are what Skip what I've sent, Skip what I've tried or Benchmarks only leave.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { GeneratorGradeScale } from '@boardsesh/playlist-generator';

const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: () => `qi-${counter++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import { DEFAULT_WORKOUT_FILTERS } from '../workout-blocks';
import {
  BORROW_GRADE_STEPS,
  MAX_BORROW_SEARCHES_PER_BUILD,
  borrowForShortSlots,
  borrowScaleFor,
  borrowedGrade,
  buildPoolsReusing,
  poolKeyForSlot,
  refreshSlotInState,
  reshufflePools,
  selectItemsFromPools,
  NO_TOP_UPS,
  type FetchGradePool,
  type GradePool,
  type PreviewFetchContext,
  type PreviewFilters,
  type PreviewItem,
  type PreviewSlot,
  type WorkoutPreviewData,
} from '../workout-preview-pool';
import { mulberry32 } from '../../../../lib/seeded-random';

const makeClimb = (uuid: string): Climb => ({ uuid, name: uuid }) as Climb;

const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard,
  isAuthenticated: true,
};

const SKIP_SENT: PreviewFilters = { ...DEFAULT_WORKOUT_FILTERS, skipSent: true };
const BENCHMARKS: PreviewFilters = { ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true };

/** A dense scale, 14..22. */
const GRADES: GeneratorGradeScale = Array.from({ length: 9 }, (_, index) => ({ difficulty_id: index + 14 }));

const slot = (grade: number, index: number, filters: PreviewFilters = SKIP_SENT): PreviewSlot => ({
  grade,
  section: 'main',
  index,
  stageId: 'stage-main',
  filters,
});

const key = (grade: number, filters: PreviewFilters = SKIP_SENT) => poolKeyForSlot(slot(grade, 0, filters));

/** `count` climbs at `grade`, named `g<grade>-<n>`. */
const climbsAt = (grade: number, count: number) =>
  Array.from({ length: count }, (_, index) => makeClimb(`g${grade}-${index}`));

/** A grade the search read out: `count` climbs is all it has under these filters. */
const allItHas = (grade: number, count: number): GradePool => ({
  climbs: climbsAt(grade, count),
  topUpTiers: NO_TOP_UPS,
  exhausted: true,
});

/** A fetcher where each grade has the climbs `countByGrade` names, and every one is searched out. */
function catalogue(countByGrade: Record<number, number>) {
  return vi.fn<FetchGradePool>(async (grade) => allItHas(grade, countByGrade[grade] ?? 0));
}

const gradeOfClimb = (preview: PreviewItem) => Number(preview.item.climb.uuid.split('-')[0].slice(1));

/** Builds, borrows and fills, the way the preview hook does. */
async function buildPreview(
  slots: PreviewSlot[],
  fetchPool: FetchGradePool,
  grades: GeneratorGradeScale = GRADES,
  cache?: WorkoutPreviewData,
  keptItems: ReadonlyArray<PreviewItem['item'] | undefined> = [],
): Promise<WorkoutPreviewData> {
  const built = await buildPoolsReusing(slots, ctx, fetchPool, cache);
  const { pools, poolDemands, poolTopUpTiers, exhaustedPoolKeys } = await borrowForShortSlots(
    slots,
    built,
    ctx,
    fetchPool,
    grades,
    { cache, keptItems },
  );
  const { items, usedUuids } = selectItemsFromPools(slots, pools, undefined, keptItems, poolTopUpTiers, grades);
  return { items, pools, usedUuids, poolDemands, poolTopUpTiers, exhaustedPoolKeys };
}

describe('borrowedGrade', () => {
  it('walks the scale by position, so ids the board skips are stepped over', () => {
    // MoonBoard-like: no 15 or 17.
    const sparse: GeneratorGradeScale = [{ difficulty_id: 14 }, { difficulty_id: 16 }, { difficulty_id: 18 }];

    expect(BORROW_GRADE_STEPS.map((step) => borrowedGrade(sparse, 16, step))).toEqual([14, 18, null, null]);
    expect(borrowedGrade(sparse, 14, -1)).toBeNull();
    expect(borrowedGrade(sparse, 15, 1)).toBeNull(); // not on the scale
    expect(borrowedGrade([], 16, -1)).toBeNull();
  });

  it('tries one easier, one harder, two easier, two harder', () => {
    expect(BORROW_GRADE_STEPS.map((step) => borrowedGrade(GRADES, 18, step))).toEqual([17, 19, 16, 20]);
  });
});

describe('borrowScaleFor', () => {
  const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

  afterEach(() => {
    if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
  });

  it('borrows along the board scale in the app', () => {
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    expect(borrowScaleFor(GRADES)).toBe(GRADES);
  });

  it('borrows nothing in a screenshot capture, whose recordings hold no nearby grade', () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    expect(borrowScaleFor(GRADES)).toEqual([]);
  });
});

describe('selectItemsFromPools with a grade scale', () => {
  it('fills a short grade from one grade easier, after the slots planned there', () => {
    const slots = [slot(17, 0), slot(18, 1), slot(18, 2), slot(18, 3)];
    const pools = new Map([
      [key(17), climbsAt(17, 2)],
      [key(18), climbsAt(18, 1)],
    ]);

    const { items, usedUuids } = selectItemsFromPools(slots, pools, undefined, undefined, undefined, GRADES);

    // The grade-17 slot keeps its own climb; one grade-18 slot borrows the
    // other 17, and the last one, with 17 used up, the grade harder (none here).
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['g17-0', 'g18-0', 'g17-1']);
    expect(items.map((preview) => preview.slot.index)).toEqual([0, 1, 2]);
    expect(items[2].slot.grade).toBe(17);
    expect(items[2].borrowedFrom).toEqual({ plannedGrade: 18 });
    expect(items[0].borrowedFrom).toBeUndefined();
    expect(items[1].borrowedFrom).toBeUndefined();
    expect(usedUuids.size).toBe(3);
  });

  it('takes the grade harder when the grade easier has nothing, then two away', () => {
    const slots = [slot(18, 0), slot(18, 1), slot(18, 2), slot(18, 3)];
    const pools = new Map([
      [key(17), []],
      [key(19), climbsAt(19, 1)],
      [key(16), climbsAt(16, 1)],
      [key(20), climbsAt(20, 5)],
    ]);

    const { items } = selectItemsFromPools(slots, pools, undefined, undefined, undefined, GRADES);

    expect(items.map(gradeOfClimb)).toEqual([19, 16, 20, 20]);
    expect(items.every((preview) => preview.borrowedFrom?.plannedGrade === 18)).toBe(true);
  });

  it('borrows upward at the bottom of the scale', () => {
    const pools = new Map([[key(15), climbsAt(15, 1)]]);

    const { items } = selectItemsFromPools([slot(14, 0)], pools, undefined, undefined, undefined, GRADES);

    expect(items[0].slot.grade).toBe(15);
    expect(items[0].borrowedFrom).toEqual({ plannedGrade: 14 });
  });

  it('gives every short slot the nearest grade before any takes one further away', () => {
    // Grades 18 and 20 both ran out. One climb at 19, one at 16, none at 17 or 21.
    const slots = [slot(18, 0), slot(20, 1)];
    const pools = new Map([
      [key(19), climbsAt(19, 1)],
      [key(16), climbsAt(16, 1)],
    ]);

    const { items } = selectItemsFromPools(slots, pools, undefined, undefined, undefined, GRADES);

    // One step easier first, for both: 20 takes the 19. Then 18 finds nothing
    // one step harder (the 19 is taken) and goes two easier, to 16. Walking
    // slot by slot instead would hand 18 the 19 and leave 20 with nothing.
    expect(items.map(gradeOfClimb)).toEqual([16, 19]);
    expect(items.map((preview) => preview.borrowedFrom?.plannedGrade)).toEqual([18, 20]);
  });

  it('never fills two rows with one climb across a borrowed pool', () => {
    const slots = [slot(17, 0), slot(17, 1), slot(18, 2)];
    const pools = new Map([
      [key(17), climbsAt(17, 2)],
      [key(18), []],
    ]);

    const { items } = selectItemsFromPools(slots, pools, undefined, undefined, undefined, GRADES);

    // Grade 17's two climbs are its own slots'; the short 18 finds nothing free.
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['g17-0', 'g17-1']);
  });

  it('borrows only from pools with the slot filters, never looser ones', () => {
    const pools = new Map([
      [key(17, DEFAULT_WORKOUT_FILTERS), climbsAt(17, 5)],
      [key(18), []],
    ]);

    const { items } = selectItemsFromPools([slot(18, 0)], pools, undefined, undefined, undefined, GRADES);

    expect(items).toEqual([]);
  });

  it('still takes an avoided climb at its own grade before borrowing', () => {
    const pools = new Map([
      [key(18), [makeClimb('queued')]],
      [key(17), climbsAt(17, 3)],
    ]);

    const { items } = selectItemsFromPools([slot(18, 0)], pools, new Set(['queued']), undefined, undefined, GRADES);

    expect(items[0].item.climb.uuid).toBe('queued');
    expect(items[0].borrowedFrom).toBeUndefined();
  });

  it('takes a fresh climb one grade harder over a queued one a grade easier', () => {
    const pools = new Map([
      [key(18), []],
      [key(17), [makeClimb('queued-17')]],
      [key(19), [makeClimb('fresh-19')]],
    ]);

    const { items } = selectItemsFromPools([slot(18, 0)], pools, new Set(['queued-17']), undefined, undefined, GRADES);

    expect(items[0].item.climb.uuid).toBe('fresh-19');
    expect(items[0].borrowedFrom).toEqual({ plannedGrade: 18 });
  });

  it('takes a queued climb at the nearest grade once no nearby grade has a fresh one', () => {
    const pools = new Map([
      [key(18), []],
      [key(17), [makeClimb('queued-17')]],
      [key(19), [makeClimb('queued-19')]],
      [key(16), []],
    ]);

    const { items } = selectItemsFromPools(
      [slot(18, 0)],
      pools,
      new Set(['queued-17', 'queued-19']),
      undefined,
      undefined,
      GRADES,
    );

    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['queued-17']);
  });

  it('marks a borrowed climb with what its own search proves', () => {
    const tried = makeClimb('g17-tried');
    const pools = new Map([
      [key(17, DEFAULT_WORKOUT_FILTERS), [tried]],
      [key(18, DEFAULT_WORKOUT_FILTERS), []],
    ]);
    const poolTopUpTiers = new Map([[key(17, DEFAULT_WORKOUT_FILTERS), new Map([[tried.uuid, 1]])]]);

    const { items } = selectItemsFromPools(
      [slot(18, 0, DEFAULT_WORKOUT_FILTERS)],
      pools,
      undefined,
      undefined,
      poolTopUpTiers,
      GRADES,
    );

    expect(items[0].knownStatus).toBe('attempt');
    expect(items[0].borrowedFrom).toEqual({ plannedGrade: 18 });
  });

  it('borrows nothing without a grade scale, as before borrowing existed', () => {
    const pools = new Map([
      [key(17), climbsAt(17, 3)],
      [key(18), []],
    ]);

    expect(selectItemsFromPools([slot(18, 0)], pools).items).toEqual([]);
  });
});

describe('borrowForShortSlots', () => {
  it('fetches nothing more when every slot fills at its own grade', async () => {
    const fetchPool = catalogue({ 18: 5 });

    const preview = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool);

    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(preview.items.every((row) => !row.borrowedFrom)).toBe(true);
  });

  it('fills a grade Skip what I have sent left short from the grade easier, with Skip sent still on', async () => {
    const fetchPool = catalogue({ 18: 2, 17: 10 });
    const slots = Array.from({ length: 5 }, (_, index) => slot(18, index));

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items).toHaveLength(5);
    expect(preview.items.filter((row) => row.borrowedFrom?.plannedGrade === 18).map(gradeOfClimb)).toEqual([
      17, 17, 17,
    ]);
    expect(fetchPool.mock.calls.map(([grade, fetchCtx, demand]) => [grade, fetchCtx.filters, demand])).toEqual([
      [18, SKIP_SENT, 5],
      // Sized by what is still unmet: the three slots grade 18 could not fill.
      [17, SKIP_SENT, 3],
    ]);
  });

  it('walks on to the grade harder only when the grade easier could not cover the gap', async () => {
    const fetchPool = catalogue({ 18: 1, 17: 1, 19: 4 });
    const slots = Array.from({ length: 4 }, (_, index) => slot(18, index));

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items.map(gradeOfClimb)).toEqual([18, 17, 19, 19]);
    expect(fetchPool.mock.calls.map(([grade, , demand]) => [grade, demand])).toEqual([
      [18, 4],
      [17, 3],
      [19, 2],
    ]);
  });

  it('shows a shortfall once every nearby grade is out too, after one search each', async () => {
    const fetchPool = catalogue({ 18: 1 });
    const slots = Array.from({ length: 3 }, (_, index) => slot(18, index, BENCHMARKS));

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items).toHaveLength(1);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17, 19, 16, 20]);
    expect(preview.items[0].borrowedFrom).toBeUndefined();
  });

  it('searches one grade easier before a pool two grades away that another block fetched', async () => {
    // A block at 16 and a block at 18 with the same filters: 16 is in hand
    // already, 18 is empty, and 17 has climbs nobody has searched yet.
    const fetchPool = catalogue({ 16: 20, 17: 20, 18: 0 });
    const slots = [slot(16, 0, BENCHMARKS), slot(18, 1, BENCHMARKS), slot(18, 2, BENCHMARKS)];

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items.map(gradeOfClimb)).toEqual([16, 17, 17]);
    expect(preview.items.map((row) => row.borrowedFrom?.plannedGrade)).toEqual([undefined, 18, 18]);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([16, 18, 17]);
  });

  it('searches one grade easier before a pool one grade harder that another block fetched', async () => {
    const fetchPool = catalogue({ 19: 20, 18: 0, 17: 20 });

    const preview = await buildPreview([slot(19, 0), slot(18, 1)], fetchPool);

    expect(preview.items.map(gradeOfClimb)).toEqual([19, 17]);
    expect(preview.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([19, 18, 17]);
  });

  it('grows a nearby pool that blocks on both sides of a grade borrow from', async () => {
    // Two 40-climb blocks at 16 and 18 with the same filters, and every climb
    // that fits at 17, which has hundreds. Fetched for the 18 block alone, 17
    // came back with 50 and the 16 block was left 30 short.
    const available: Record<number, number> = { 17: 300 };
    const fetchPool = vi.fn<FetchGradePool>(async (grade, _ctx, demand) => {
      const count = Math.min(available[grade] ?? 0, demand + 10);
      return { climbs: climbsAt(grade, count), topUpTiers: NO_TOP_UPS, exhausted: count === (available[grade] ?? 0) };
    });
    const slots = [
      ...Array.from({ length: 40 }, (_, index) => slot(16, index, BENCHMARKS)),
      ...Array.from({ length: 40 }, (_, index) => slot(18, 40 + index, BENCHMARKS)),
    ];

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items).toHaveLength(80);
    expect(new Set(preview.items.map((row) => row.item.climb.uuid)).size).toBe(80);
    expect(preview.items.every((row) => gradeOfClimb(row) === 17)).toBe(true);
    expect(preview.items.filter((row) => row.borrowedFrom?.plannedGrade === 16)).toHaveLength(40);
    expect(preview.items.filter((row) => row.borrowedFrom?.plannedGrade === 18)).toHaveLength(40);
    // 17 was searched for the 18 block, then again for both blocks' 80 rows,
    // and 15, one grade easier for the 16 block, came first.
    const searches = fetchPool.mock.calls.map(([grade, , demand]) => [grade, demand]);
    expect(searches).toEqual([
      [16, 40],
      [18, 40],
      [15, 40],
      [17, 40],
      [17, 80],
    ]);
  });

  it('stops growing a nearby pool once a search finds no more climbs', async () => {
    // Grade 17 never reports itself read out (a page cap, say) but has only 12.
    const fetchPool = vi.fn<FetchGradePool>(async (grade, _ctx, demand) => ({
      climbs: climbsAt(grade, grade === 17 ? Math.min(12, demand + 2) : 0),
      topUpTiers: NO_TOP_UPS,
      exhausted: grade !== 17,
    }));
    const slots = [
      ...Array.from({ length: 10 }, (_, index) => slot(16, index, BENCHMARKS)),
      ...Array.from({ length: 10 }, (_, index) => slot(18, 10 + index, BENCHMARKS)),
    ];

    const preview = await buildPreview(slots, fetchPool);

    // 17's twelve climbs fill twelve rows. Searched again for its 12 rows and
    // the 8 slots still short, it comes back with the same twelve and is left.
    expect(preview.items.filter((row) => gradeOfClimb(row) === 17)).toHaveLength(12);
    const seventeen = fetchPool.mock.calls.filter(([grade]) => grade === 17).map(([, , demand]) => demand);
    expect(seventeen).toEqual([10, 20]);
    expect(fetchPool.mock.calls.length).toBeLessThanOrEqual(2 + MAX_BORROW_SEARCHES_PER_BUILD);
  });

  it('searches the grade harder when the grade easier has only climbs already in the queue', async () => {
    // Adding a block mid-session: grade 17's one climb is in the queue.
    const fetchPool = catalogue({ 18: 0, 17: 1, 19: 1 });
    const queued = new Set(['g17-0']);
    const slots = [slot(18, 0)];
    const built = await buildPoolsReusing(slots, ctx, fetchPool);

    const { pools, poolTopUpTiers } = await borrowForShortSlots(slots, built, ctx, fetchPool, GRADES, {
      avoidClimbUuids: queued,
    });
    const { items } = selectItemsFromPools(slots, pools, queued, undefined, poolTopUpTiers, GRADES);

    expect(items.map((row) => row.item.climb.uuid)).toEqual(['g19-0']);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17, 19]);
  });

  it(`sends at most ${MAX_BORROW_SEARCHES_PER_BUILD} nearby searches a build, nearest steps first`, async () => {
    // Three blocks at 18 with their own filters, on a board with nothing nearby.
    const skipTried: PreviewFilters = { ...DEFAULT_WORKOUT_FILTERS, skipTried: true };
    const fetchPool = catalogue({});
    const slots = [slot(18, 0, SKIP_SENT), slot(18, 1, BENCHMARKS), slot(18, 2, skipTried)];

    const first = await buildPreview(slots, fetchPool);

    expect(MAX_BORROW_SEARCHES_PER_BUILD).toBe(6);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 18, 18, 17, 17, 17, 19, 19, 19]);

    // The next rebuild reuses what this one found and spends its searches
    // on the steps the cap left.
    fetchPool.mockClear();
    await buildPreview(slots, fetchPool, GRADES, first);

    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([16, 16, 16, 20, 20, 20]);
  });

  it('borrows into a grade the plan already has, without searching it again when it is read out', async () => {
    // Skip what I've tried: a pyramid whose peak ran out, and a grade below that
    // has a climb to spare for it.
    const skipTried: PreviewFilters = { ...DEFAULT_WORKOUT_FILTERS, skipTried: true };
    const fetchPool = catalogue({ 17: 3, 18: 0 });
    const slots = [slot(17, 0, skipTried), slot(17, 1, skipTried), slot(18, 2, skipTried)];

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items.map(gradeOfClimb)).toEqual([17, 17, 17]);
    expect(preview.items[2].borrowedFrom).toEqual({ plannedGrade: 18 });
    // 17 and 18 were each searched once, by the plan; 17 is read out, so the
    // borrow pass reused it.
    expect(fetchPool.mock.calls.filter(([grade]) => grade === 17)).toHaveLength(1);
  });

  it('reuses a nearby pool from the previous build, so another edit searches it no more', async () => {
    // Grade 17 has more than the search read: not read out, but enough for the gap.
    const fetchPool = vi.fn<FetchGradePool>(async (grade) =>
      grade === 17 ? { climbs: climbsAt(17, 10), topUpTiers: NO_TOP_UPS } : allItHas(grade, grade === 18 ? 2 : 3),
    );
    const fiveAt18 = Array.from({ length: 5 }, (_, index) => slot(18, index));
    const first = await buildPreview(fiveAt18, fetchPool);

    // The climber edits another block: the plan grows by a slot at 21.
    const second = await buildPreview([...fiveAt18, slot(21, 5)], fetchPool, GRADES, first);

    expect(second.items.filter((row) => row.borrowedFrom)).toHaveLength(3);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17, 21]);
  });

  it('skips a nearby grade whose search fails and tries the next one', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async (grade) => {
      if (grade === 17) throw new Error('network');
      return allItHas(grade, grade === 18 ? 1 : 4);
    });
    const slots = [slot(18, 0), slot(18, 1), slot(18, 2)];

    const preview = await buildPreview(slots, fetchPool);

    expect(preview.items.map(gradeOfClimb)).toEqual([18, 19, 19]);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17, 19]);
  });

  it('stops borrowing once the build is superseded', async () => {
    let current = true;
    const fetchPool = vi.fn<FetchGradePool>(async (grade) => {
      if (grade === 17) current = false; // the climber moves on mid-borrow
      return allItHas(grade, grade === 18 ? 0 : 1);
    });
    const slots = [slot(18, 0), slot(18, 1)];
    const supersedable = { ...ctx, isCurrent: () => current };
    const built = await buildPoolsReusing(slots, supersedable, fetchPool);

    await borrowForShortSlots(slots, built, supersedable, fetchPool, GRADES);

    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17]);
  });

  it('borrows nothing with an empty grade scale', async () => {
    const fetchPool = catalogue({ 18: 1, 17: 5 });

    const preview = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool, []);

    expect(preview.items).toHaveLength(1);
    expect(fetchPool).toHaveBeenCalledTimes(1);
  });

  it('keeps a borrowed row of an untouched block through a rebuild', async () => {
    const fetchPool = catalogue({ 18: 1, 17: 10, 21: 5 });
    const twoAt18 = [slot(18, 0), slot(18, 1)];
    const first = await buildPreview(twoAt18, fetchPool);
    const borrowedRow = first.items[1];
    expect(borrowedRow.borrowedFrom).toEqual({ plannedGrade: 18 });

    // Another block is added after it; this block's rows are offered back.
    const second = await buildPreview(
      [...twoAt18, slot(21, 2)],
      fetchPool,
      GRADES,
      first,
      first.items.map((row) => row.item),
    );

    expect(second.items[1].item).toBe(borrowedRow.item);
    expect(second.items[1].slot.grade).toBe(17);
    expect(second.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
  });
});

describe('refreshSlotInState for a borrowed row', () => {
  /** Grade 18 has one climb (on row 0); row 1 borrowed from 17. */
  async function shortAt18(countAt17 = 4) {
    const fetchPool = catalogue({ 18: 1, 17: countAt17, 19: 4 });
    const state = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool);
    fetchPool.mockClear();
    return { state, fetchPool };
  }

  it('re-rolls within the grade it borrowed from without searching grade 18 again', async () => {
    const { state, fetchPool } = await shortAt18();
    const target = state.items[1];

    const { state: next, changed } = await refreshSlotInState(
      state,
      target.item.uuid,
      ctx,
      fetchPool,
      undefined,
      GRADES,
    );

    expect(changed).toBe(true);
    expect(next.items[1].item.uuid).toBe(target.item.uuid);
    expect(next.items[1].item.climb.uuid).not.toBe(target.item.climb.uuid);
    expect(gradeOfClimb(next.items[1])).toBe(17);
    expect(next.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('goes back to the planned grade first once it has a climb free', async () => {
    const { state, fetchPool } = await shortAt18();
    // Grade 18 turns out to have another climb (a refetch found it).
    state.pools.set(key(18), [...(state.pools.get(key(18)) ?? []), makeClimb('g18-new')]);

    const { state: next } = await refreshSlotInState(
      state,
      state.items[1].item.uuid,
      ctx,
      fetchPool,
      undefined,
      GRADES,
    );

    expect(next.items[1].item.climb.uuid).toBe('g18-new');
    expect(next.items[1].slot.grade).toBe(18);
    expect(next.items[1].borrowedFrom).toBeUndefined();
  });

  it('borrows the next grade over when its own nearby grade is out too', async () => {
    const { state, fetchPool } = await shortAt18(1);

    const { state: next } = await refreshSlotInState(
      state,
      state.items[1].item.uuid,
      ctx,
      fetchPool,
      undefined,
      GRADES,
    );

    expect(gradeOfClimb(next.items[1])).toBe(19);
    expect(next.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
    // 19 was never needed by the build, so the refresh searched it once.
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([19]);
  });

  it('passes over queued climbs at the grade it borrowed from for a fresh one a grade harder', async () => {
    const fetchPool = catalogue({ 18: 1, 17: 3, 19: 2 });
    const state = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool);
    fetchPool.mockClear();
    const target = state.items[1];
    // Mid-session: every other grade-17 climb is already in the queue.
    const queued = new Set(climbsAt(17, 3).map((climb) => climb.uuid));
    queued.delete(target.item.climb.uuid);

    const { state: next } = await refreshSlotInState(state, target.item.uuid, ctx, fetchPool, queued, GRADES);

    expect(gradeOfClimb(next.items[1])).toBe(19);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([19]);
  });

  it('keeps a borrowed row and its caption when no grade it may use has a climb no row shows', async () => {
    // QA on Kilter 40, Benchmarks only: refreshing "V9 for V10" turned it into a
    // second copy of the one V10 climb, which another row already showed.
    const fetchPool = catalogue({ 18: 1, 17: 1 });
    const state = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool);
    fetchPool.mockClear();
    const target = state.items[1];
    expect(target.borrowedFrom).toEqual({ plannedGrade: 18 });

    const result = await refreshSlotInState(state, target.item.uuid, ctx, fetchPool, undefined, GRADES);

    expect(result.changed).toBe(false);
    expect(result.nothingNew).toBe(true);
    expect(result.state.items).toBe(state.items);
    expect(result.state.items.map((row) => row.item.climb.uuid)).toEqual(['g18-0', 'g17-0']);
    expect(result.state.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
    // 18 and 17 are read out; each other step was searched once, nearest first.
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([19, 16, 20]);

    // Those searches are kept, so tapping again searches nothing.
    fetchPool.mockClear();
    const again = await refreshSlotInState(result.state, target.item.uuid, ctx, fetchPool, undefined, GRADES);
    expect(again.nothingNew).toBe(true);
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('searches each pool again at most once, so tapping a row with nothing new sends no more requests', async () => {
    // Benchmarks only on a busy grade: the search stops at its page cap, so no
    // pool is ever read out, and every grade it may use holds only shown climbs.
    const fetchPool = vi.fn<FetchGradePool>(async (grade) => ({
      climbs: climbsAt(grade, grade === 18 || grade === 17 ? 1 : 0),
      topUpTiers: NO_TOP_UPS,
    }));
    const state = await buildPreview([slot(18, 0, BENCHMARKS), slot(18, 1, BENCHMARKS)], fetchPool);
    fetchPool.mockClear();
    const target = state.items[1];

    const first = await refreshSlotInState(state, target.item.uuid, ctx, fetchPool, undefined, GRADES);
    expect(first.nothingNew).toBe(true);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17, 19, 16, 20]);

    fetchPool.mockClear();
    const second = await refreshSlotInState(first.state, target.item.uuid, ctx, fetchPool, undefined, GRADES);
    expect(second.nothingNew).toBe(true);
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('tries the planned grade, then each borrow step in order, and stops at the first fresh climb', async () => {
    // Nothing is read out, so every grade can be searched again. Only 16, two
    // grades easier, has a climb no row shows.
    const countByGrade: Record<number, number> = { 18: 1, 17: 1, 19: 0, 16: 1, 20: 1 };
    const fetchPool = vi.fn<FetchGradePool>(async (grade) => ({
      climbs: climbsAt(grade, countByGrade[grade] ?? 0),
      topUpTiers: NO_TOP_UPS,
    }));
    const slots = [slot(18, 0), slot(18, 1)];
    const built = await buildPoolsReusing(slots, ctx, fetchPool);
    const { pools, poolDemands, poolTopUpTiers, exhaustedPoolKeys } = await borrowForShortSlots(
      slots,
      built,
      ctx,
      fetchPool,
      GRADES,
    );
    const { items, usedUuids } = selectItemsFromPools(slots, pools, undefined, undefined, poolTopUpTiers, GRADES);
    const state: WorkoutPreviewData = { items, pools, usedUuids, poolDemands, poolTopUpTiers, exhaustedPoolKeys };
    expect(items.map((row) => row.item.climb.uuid)).toEqual(['g18-0', 'g17-0']);
    fetchPool.mockClear();

    const { state: next, changed } = await refreshSlotInState(
      state,
      items[1].item.uuid,
      ctx,
      fetchPool,
      undefined,
      GRADES,
    );

    expect(changed).toBe(true);
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([18, 17, 19, 16]);
    expect(next.items[1].item.climb.uuid).toBe('g16-0');
    expect(next.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
    expect(new Set(next.items.map((row) => row.item.climb.uuid)).size).toBe(2);
  });

  it('takes a queued climb at a nearby grade once no nearby grade has a fresh one', async () => {
    const fetchPool = catalogue({ 18: 1, 17: 3 });
    const state = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool);
    fetchPool.mockClear();
    const target = state.items[1];
    const queued = new Set(climbsAt(17, 3).map((climb) => climb.uuid));
    queued.delete(target.item.climb.uuid);

    const { state: next } = await refreshSlotInState(state, target.item.uuid, ctx, fetchPool, queued, GRADES);

    expect(queued.has(next.items[1].item.climb.uuid)).toBe(true);
    expect(next.items[1].borrowedFrom).toEqual({ plannedGrade: 18 });
    // Each nearby grade was searched once for a fresh climb first.
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([19, 16, 20]);
  });

  it('borrows when a row at its planned grade runs out on refresh', async () => {
    const fetchPool = catalogue({ 18: 2, 17: 3 });
    const state = await buildPreview([slot(18, 0), slot(18, 1)], fetchPool);
    expect(state.items.every((row) => !row.borrowedFrom)).toBe(true);
    fetchPool.mockClear();

    const { state: next } = await refreshSlotInState(
      state,
      state.items[0].item.uuid,
      ctx,
      fetchPool,
      undefined,
      GRADES,
    );

    expect(gradeOfClimb(next.items[0])).toBe(17);
    expect(next.items[0].borrowedFrom).toEqual({ plannedGrade: 18 });
    // Grade 18 is read out, so only 17 was searched.
    expect(fetchPool.mock.calls.map(([grade]) => grade)).toEqual([17]);
  });
});

describe('Shuffle with borrowed rows', () => {
  it('borrows again from the pools it has, without a search', async () => {
    const fetchPool = catalogue({ 18: 2, 17: 6 });
    const slots = Array.from({ length: 4 }, (_, index) => slot(18, index));
    const state = await buildPreview(slots, fetchPool);
    fetchPool.mockClear();

    const pools = reshufflePools(state.pools, state.poolTopUpTiers, mulberry32(5));
    const { items } = selectItemsFromPools(slots, pools, undefined, undefined, state.poolTopUpTiers, GRADES);

    expect(items).toHaveLength(4);
    expect(items.filter((row) => row.borrowedFrom?.plannedGrade === 18)).toHaveLength(2);
    expect(new Set(items.map((row) => row.item.climb.uuid)).size).toBe(4);
    expect(fetchPool).not.toHaveBeenCalled();
  });
});
