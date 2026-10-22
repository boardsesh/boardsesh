import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

// Monotonic uuids so each generated queue item is distinct (the real
// climbToQueueItem uses expo-crypto's randomUUID for the queue-item uuid).
const cryptoMock = vi.hoisted(() => {
  let n = 0;
  return { randomUUID: () => `qi-${n++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import {
  buildPools,
  buildPoolsReusing,
  fetchFilters,
  filtersSignature,
  pickRandomUnused,
  poolKeyForSlot,
  pickUnused,
  refreshSlotInState,
  reshufflePools,
  selectItemsFromPools,
  shuffleInPlace,
  type PreviewFetchContext,
  type PreviewFilters,
  type PreviewSlot,
  type WorkoutPreviewData,
} from '../workout-preview-pool';
import { screenshotModeRandom } from '../../../../lib/screenshot-mode';
import { mulberry32 } from '../../../../lib/seeded-random';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1145r15',
    setter_username: 'tester',
    angle: 40,
    ascensionist_count: 10,
    difficulty: '6a',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    is_no_match: false,
  } as Climb;
}

function slot(grade: number, index: number, filters?: PreviewFilters): PreviewSlot {
  return { grade, section: 'main', index, ...(filters ? { filters } : {}) };
}

/** The pool key an unfiltered slot (or one with `filters`) at `grade` draws from. */
function key(grade: number, filters?: PreviewFilters): string {
  return poolKeyForSlot(slot(grade, 0, filters));
}

const LOOSE: PreviewFilters = {
  climbBias: 'any',
  minAscents: 0,
  minRating: 0,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
};
const STRICT: PreviewFilters = { ...LOOSE, minAscents: 50, minRating: 3 };

const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard,
  isAuthenticated: false,
};

function buildState(poolByGrade: Record<number, string[]>, slotSpecs: [number, number][]): WorkoutPreviewData {
  const pools = new Map<string, Climb[]>(
    Object.entries(poolByGrade).map(([grade, uuids]) => [key(Number(grade)), uuids.map(makeClimb)]),
  );
  const slots = slotSpecs.map(([grade, index]) => slot(grade, index));
  const { items, usedUuids } = selectItemsFromPools(slots, pools);
  return { items, pools, usedUuids };
}

describe('pickUnused', () => {
  it('returns the first climb not in the used set', () => {
    const pool = [makeClimb('a'), makeClimb('b'), makeClimb('c')];
    expect(pickUnused(pool, new Set(['a']))?.uuid).toBe('b');
    expect(pickUnused(pool, new Set(['a', 'b', 'c']))).toBeNull();
  });
});

describe('pickRandomUnused', () => {
  it('returns a climb not in the used set', () => {
    const pool = [makeClimb('a'), makeClimb('b'), makeClimb('c')];
    const picked = pickRandomUnused(pool, new Set(['a']));
    expect(picked).not.toBeNull();
    expect(['b', 'c']).toContain(picked?.uuid);
  });

  it('returns null when every climb is used', () => {
    const pool = [makeClimb('a'), makeClimb('b')];
    expect(pickRandomUnused(pool, new Set(['a', 'b']))).toBeNull();
  });

  it('can pick a non-first unused climb (not just the first like pickUnused)', () => {
    const pool = [makeClimb('a'), makeClimb('b'), makeClimb('c'), makeClimb('d')];
    // Unused candidates are [b, c, d]; index 2 → 'd'. A value of 0.9 lands there.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    try {
      expect(pickRandomUnused(pool, new Set(['a']))?.uuid).toBe('d');
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe('selectItemsFromPools', () => {
  it('picks a distinct climb per slot when the pool is large enough', () => {
    const pools = new Map([[key(10), [makeClimb('a'), makeClimb('b'), makeClimb('c')]]]);
    const { items, usedUuids } = selectItemsFromPools([slot(10, 0), slot(10, 1), slot(10, 2)], pools);
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a', 'b', 'c']);
    expect(usedUuids).toEqual(new Set(['a', 'b', 'c']));
  });

  it('skips slots when the pool is shorter than the slot count', () => {
    const pools = new Map([[key(10), [makeClimb('a')]]]);
    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1)], pools);
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a']);
  });

  it('skips a slot whose grade pool is empty', () => {
    const pools = new Map([[key(10), []]]);
    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1)], pools);
    expect(items).toEqual([]);
  });

  it('passes over avoided climbs while the pool has others', () => {
    const pools = new Map([[key(10), [makeClimb('queued'), makeClimb('a'), makeClimb('b')]]]);
    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1)], pools, new Set(['queued']));
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a', 'b']);
  });

  it('falls back to an avoided climb rather than leave a slot empty', () => {
    const pools = new Map([[key(10), [makeClimb('queued'), makeClimb('a')]]]);
    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1)], pools, new Set(['queued']));
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a', 'queued']);
  });
});

describe('buildPools', () => {
  it('fetches one shuffled pool per unique grade', async () => {
    const fetchPool = vi.fn(async (grade: number) => [makeClimb(`${grade}-x`), makeClimb(`${grade}-y`)]);
    const pools = await buildPools([slot(10, 0), slot(10, 1), slot(12, 2)], ctx, fetchPool);
    expect(fetchPool).toHaveBeenCalledTimes(2); // grades 10 and 12, deduped
    expect(pools.get(key(10))).toHaveLength(2);
    expect(pools.get(key(12))).toHaveLength(2);
  });
});

describe('pools keyed by grade and filters', () => {
  it('gives equal filters one signature and different filters another', () => {
    expect(filtersSignature({ ...STRICT })).toBe(filtersSignature(STRICT));
    expect(filtersSignature(STRICT)).not.toBe(filtersSignature(LOOSE));
    expect(filtersSignature({ ...LOOSE, onlyWideClimbs: true })).not.toBe(filtersSignature(LOOSE));
    expect(key(10, STRICT)).not.toBe(key(10, LOOSE));
    expect(key(10, STRICT)).not.toBe(key(11, STRICT));
  });

  it('fetches each slot with its own filters, one pool per grade and filter set', async () => {
    const fetchPool = vi.fn(async (grade: number, fetchCtx: PreviewFetchContext) => [
      makeClimb(`${grade}-${filtersSignature(fetchCtx.filters)}`),
    ]);
    const pools = await buildPools([slot(10, 0, LOOSE), slot(10, 1, STRICT), slot(12, 2, STRICT)], ctx, fetchPool);

    expect(fetchPool).toHaveBeenCalledTimes(3);
    // Each pool at grade 10 is sized for both of grade 10's slots.
    expect(fetchPool).toHaveBeenCalledWith(10, { ...ctx, filters: LOOSE }, 2);
    expect(fetchPool).toHaveBeenCalledWith(10, { ...ctx, filters: STRICT }, 2);
    expect(fetchPool).toHaveBeenCalledWith(12, { ...ctx, filters: STRICT }, 1);
    expect(pools.get(key(10, LOOSE))?.[0].uuid).toBe(`10-${filtersSignature(LOOSE)}`);
    expect(pools.get(key(10, STRICT))?.[0].uuid).toBe(`10-${filtersSignature(STRICT)}`);
  });

  it('shares one pool between slots with equal filters, sized by their combined demand', async () => {
    const fetchPool = vi.fn(async () => [makeClimb('a')]);
    // Two stages' slots, each with its own copy of the same filters.
    await buildPools(
      [slot(10, 0, { ...STRICT }), slot(10, 1, { ...STRICT }), slot(10, 2, { ...STRICT })],
      ctx,
      fetchPool,
    );

    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(fetchPool).toHaveBeenCalledWith(10, { ...ctx, filters: STRICT }, 3);
  });

  it('fills every slot when two filter sets at one grade return the same climbs', async () => {
    // V5 x20 on the defaults plus V5 x20 and x15 on stricter filters: 55 slots
    // at one grade. Both filter sets return the same top-quality climbs, sized
    // like fetchGradePool (at least 50, else demand + 10).
    const fetchPool = vi.fn(async (_grade: number, _ctx: PreviewFetchContext, demand: number) =>
      Array.from({ length: Math.max(50, demand + 10) }, (_, index) => makeClimb(`climb-${index}`)),
    );
    const slots = [
      ...Array.from({ length: 20 }, (_, index) => slot(10, index, LOOSE)),
      ...Array.from({ length: 35 }, (_, index) => slot(10, 20 + index, STRICT)),
    ];

    const pools = await buildPools(slots, ctx, fetchPool);
    const { items } = selectItemsFromPools(slots, pools);

    expect(fetchPool).toHaveBeenCalledWith(10, { ...ctx, filters: LOOSE }, 55);
    expect(fetchPool).toHaveBeenCalledWith(10, { ...ctx, filters: STRICT }, 55);
    expect(items).toHaveLength(55);
    expect(new Set(items.map((preview) => preview.item.climb.uuid)).size).toBe(55);
  });

  it('reuses a cached pool fetched for enough slots, and refetches one that is new or too small', async () => {
    const fetchPool = vi.fn(async (grade: number) => [makeClimb(`fresh-${grade}`)]);
    const cachedLoose = [makeClimb('cached-loose'), makeClimb('cached-loose-2')];
    const cachedStrict = [makeClimb('cached-strict')];
    const cache = {
      pools: new Map([
        [key(10, LOOSE), cachedLoose],
        [key(10, STRICT), cachedStrict],
      ]),
      poolDemands: new Map([
        [key(10, LOOSE), 5],
        [key(10, STRICT), 1],
      ]),
    };

    const { pools, poolDemands } = await buildPoolsReusing(
      [slot(10, 0, LOOSE), slot(10, 1, STRICT), slot(12, 2, LOOSE)],
      ctx,
      fetchPool,
      cache,
    );

    expect(pools.get(key(10, LOOSE))).toBe(cachedLoose);
    expect(poolDemands.get(key(10, LOOSE))).toBe(5);
    // Fetched for one slot, it now has to cover both of grade 10's.
    expect(pools.get(key(10, STRICT))?.[0].uuid).toBe('fresh-10');
    expect(poolDemands.get(key(10, STRICT))).toBe(2);
    expect(pools.get(key(12, LOOSE))?.[0].uuid).toBe('fresh-12');
    expect(fetchPool).toHaveBeenCalledTimes(2);
  });

  it('refetches a cached pool that came back with fewer climbs than its slots', async () => {
    const fetchPool = vi.fn(async (grade: number) => [makeClimb(`fresh-${grade}`)]);
    const cache = { pools: new Map([[key(10, LOOSE), []]]), poolDemands: new Map([[key(10, LOOSE), 5]]) };

    const { pools } = await buildPoolsReusing([slot(10, 0, LOOSE)], ctx, fetchPool, cache);

    expect(pools.get(key(10, LOOSE))?.[0].uuid).toBe('fresh-10');
    expect(fetchPool).toHaveBeenCalledTimes(1);
  });

  it('keeps a row whose climb is still in its pool, and refills the rest', () => {
    const pools = new Map([[key(10), [makeClimb('a'), makeClimb('b'), makeClimb('kept')]]]);
    const keptRow = selectItemsFromPools([slot(10, 0)], new Map([[key(10), [makeClimb('kept')]]])).items[0].item;
    const goneRow = selectItemsFromPools([slot(10, 0)], new Map([[key(10), [makeClimb('gone')]]])).items[0].item;

    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1), slot(10, 2)], pools, undefined, [
      undefined,
      keptRow,
      goneRow,
    ]);

    // The kept row stays as it was, uuid and all; the others never take its climb.
    expect(items[1].item).toBe(keptRow);
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a', 'kept', 'b']);
  });

  it('sets climb bias aside in the pool key while signed out, where the search cannot use it', () => {
    const attempted = { ...LOOSE, climbBias: 'attempted' as const };

    expect(fetchFilters(attempted, false)).toEqual(LOOSE);
    expect(fetchFilters(attempted, true)).toBe(attempted);
    expect(fetchFilters(undefined, false)).toBeUndefined();
  });

  it('never fills two slots with one climb, even from two pools that both hold it', () => {
    const pools = new Map([
      [key(10, LOOSE), [makeClimb('shared'), makeClimb('loose-only')]],
      [key(10, STRICT), [makeClimb('shared'), makeClimb('strict-only')]],
    ]);
    const { items, usedUuids } = selectItemsFromPools([slot(10, 0, LOOSE), slot(10, 1, STRICT)], pools);

    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['shared', 'strict-only']);
    expect(usedUuids).toEqual(new Set(['shared', 'strict-only']));
  });

  it('refreshes a row from its own pool and refetches with its own filters', async () => {
    const pools = new Map([
      [key(10, LOOSE), [makeClimb('loose-a'), makeClimb('loose-b')]],
      [key(10, STRICT), [makeClimb('strict-a')]],
    ]);
    const { items, usedUuids } = selectItemsFromPools([slot(10, 0, LOOSE), slot(10, 1, STRICT)], pools);
    const state: WorkoutPreviewData = { items, pools, usedUuids };
    const fetchPool = vi.fn(async () => [makeClimb('strict-a'), makeClimb('strict-b')]);

    const { state: next } = await refreshSlotInState(state, items[1].item.uuid, ctx, fetchPool);

    // The strict pool had nothing unused, so it refetched with the strict filters
    // rather than take the loose pool's spare climb.
    // Sized past every row at grade 10, the loose row included.
    expect(fetchPool).toHaveBeenCalledWith(10, { ...ctx, filters: STRICT }, 3);
    expect(next.items[1].item.climb.uuid).toBe('strict-b');
    expect(next.pools.get(key(10, LOOSE))?.map((climb) => climb.uuid)).toEqual(['loose-a', 'loose-b']);
  });
});

describe('refreshSlotInState', () => {
  it('keeps the queue-item uuid and swaps to a different climb from the cache', async () => {
    const state = buildState({ 10: ['a', 'b'] }, [[10, 0]]); // one slot → climb 'a'
    const targetUuid = state.items[0].item.uuid;
    const fetchPool = vi.fn();

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(true);
    expect(next.items[0].item.uuid).toBe(targetUuid); // queue-item identity preserved
    expect(next.items[0].item.climb.uuid).toBe('b'); // genuinely different climb
    expect(fetchPool).not.toHaveBeenCalled(); // cache had an unused climb
    expect(next.usedUuids).toEqual(new Set(['b']));
  });

  it('re-rolls across the pool instead of toggling between two climbs', async () => {
    // One slot, five-climb pool → initial pick is 'a'. The old first-unused
    // refresh toggled a↔b forever; a random pick reaches the rest of the pool.
    let state = buildState({ 10: ['a', 'b', 'c', 'd', 'e'] }, [[10, 0]]);
    expect(state.items[0].item.climb.uuid).toBe('a');
    const fetchPool = vi.fn();

    // Refresh 1: unused = [b, c, d, e]; 0.3 * 4 → index 1 → 'c'.
    // Refresh 2: unused = [a, b, d, e]; 0.8 * 4 → index 3 → 'e'.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.3).mockReturnValueOnce(0.8);
    try {
      const seen = new Set([state.items[0].item.climb.uuid]);
      for (let refresh = 0; refresh < 2; refresh++) {
        const targetUuid = state.items[0].item.uuid;
        const result = await refreshSlotInState(state, targetUuid, ctx, fetchPool);
        expect(result.changed).toBe(true);
        state = result.state;
        seen.add(state.items[0].item.climb.uuid);
      }
      expect(seen).toEqual(new Set(['a', 'c', 'e'])); // three distinct climbs, not an a↔b toggle
      expect(fetchPool).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('refreshes within the slot grade and never crosses into another grade', async () => {
    // Pyramid/ladder workouts put different grades in different slots. Refreshing
    // a grade-18 row must always land on another grade-18 climb, never the
    // grade-17 slot's climbs — the pool is keyed by slot.grade.
    let state = buildState({ 17: ['g17-a', 'g17-b', 'g17-c'], 18: ['g18-a', 'g18-b', 'g18-c'] }, [
      [17, 0],
      [18, 1],
    ]);
    const grade18Uuid = state.items[1].item.uuid; // queue-item uuid is preserved across refreshes
    const fetchPool = vi.fn();

    const seen = new Set<string>([state.items[1].item.climb.uuid]);
    for (let refresh = 0; refresh < 8; refresh++) {
      const result = await refreshSlotInState(state, grade18Uuid, ctx, fetchPool);
      expect(result.changed).toBe(true);
      state = result.state;
      const refreshedUuid = state.items[1].item.climb.uuid;
      expect(refreshedUuid.startsWith('g18-')).toBe(true); // stayed on grade 18
      seen.add(refreshedUuid);
      expect(state.items[0].item.climb.uuid.startsWith('g17-')).toBe(true); // grade-17 row untouched
    }
    expect(seen.size).toBeGreaterThan(1); // re-rolled within grade 18 rather than sticking
    expect([...seen].every((uuid) => uuid.startsWith('g18-'))).toBe(true); // every pick stayed on grade
    expect(fetchPool).not.toHaveBeenCalled(); // cache always had an unused grade-18 climb
  });

  it('never re-picks a climb already shown in another row (cache miss → refetch)', async () => {
    // Two slots at grade 10, pool exactly [a, b] → rows show a and b (both used).
    const state = buildState({ 10: ['a', 'b'] }, [
      [10, 0],
      [10, 1],
    ]);
    const targetUuid = state.items[0].item.uuid; // currently 'a'
    // Refetch returns a fresh climb 'c' not shown anywhere.
    const fetchPool = vi.fn(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(true);
    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(next.items[0].item.climb.uuid).toBe('c'); // the only not-elsewhere-shown climb
    expect(next.items[1].item.climb.uuid).toBe('b'); // sibling untouched
  });

  it('allows a differing repeat when every climb at the grade is already shown', async () => {
    // Two slots, two-climb catalog → a and b both used; refetch yields nothing new.
    const state = buildState({ 10: ['a', 'b'] }, [
      [10, 0],
      [10, 1],
    ]);
    const targetUuid = state.items[0].item.uuid; // 'a'
    const fetchPool = vi.fn(async () => [makeClimb('a'), makeClimb('b')]);

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(true);
    expect(next.items[0].item.climb.uuid).toBe('b'); // differs from the old 'a' (a duplicate of row 1)
  });

  it('no-ops when the grade has only the climb already shown', async () => {
    const state = buildState({ 10: ['a'] }, [[10, 0]]);
    const targetUuid = state.items[0].item.uuid;
    const fetchPool = vi.fn(async () => [makeClimb('a')]);

    const { changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(false);
  });

  // Mid-session the avoided set is the live queue: a refresh must not re-pick a
  // climb an earlier block already queued while the pool has others.
  it('passes over avoided climbs while the pool has others', async () => {
    const state = buildState({ 10: ['a', 'b', 'c', 'd'] }, [[10, 0]]); // shows 'a'
    const targetUuid = state.items[0].item.uuid;
    const fetchPool = vi.fn();

    for (let refresh = 0; refresh < 10; refresh++) {
      const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool, new Set(['b', 'c']));
      expect(changed).toBe(true);
      expect(next.items[0].item.climb.uuid).toBe('d');
    }
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('falls back to an avoided climb when only avoided ones are left, without refetching', async () => {
    const state = buildState({ 10: ['a', 'b'] }, [[10, 0]]); // shows 'a'
    const targetUuid = state.items[0].item.uuid;
    const fetchPool = vi.fn();

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool, new Set(['b']));

    expect(changed).toBe(true);
    expect(next.items[0].item.climb.uuid).toBe('b');
    // An avoided climb is still unused, so the cache is not exhausted.
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('prefers a non-avoided climb from the refetch once the cache is exhausted', async () => {
    const state = buildState({ 10: ['a', 'b'] }, [
      [10, 0],
      [10, 1],
    ]);
    const targetUuid = state.items[0].item.uuid; // 'a'
    const fetchPool = vi.fn(async () => ['a', 'b', 'c', 'd'].map(makeClimb));

    const { state: next } = await refreshSlotInState(state, targetUuid, ctx, fetchPool, new Set(['c']));

    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(next.items[0].item.climb.uuid).toBe('d');
  });

  it('no-ops for a stale uuid that is no longer in the list', async () => {
    const state = buildState({ 10: ['a', 'b'] }, [[10, 0]]);
    const fetchPool = vi.fn();
    const { changed } = await refreshSlotInState(state, 'nonexistent', ctx, fetchPool);
    expect(changed).toBe(false);
    expect(fetchPool).not.toHaveBeenCalled();
  });
});

describe('shuffleInPlace', () => {
  const deck = () => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  it('takes an injected source, so the same seed shuffles the same way twice', () => {
    expect(shuffleInPlace(deck(), mulberry32(4242))).toEqual(shuffleInPlace(deck(), mulberry32(4242)));
  });

  it('is still a permutation, not a filter', () => {
    expect([...shuffleInPlace(deck(), mulberry32(7))].sort()).toEqual(deck());
  });

  describe('in screenshot mode', () => {
    const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

    afterEach(() => {
      if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
    });

    it('lands on ONE pinned order, so the workout shot is byte-stable across replays', () => {
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
      // Pinned to SCREENSHOT_RANDOM_SEED. If this changes, the committed fixture
      // set no longer covers the climbs the generator picks, and every replay
      // asks the backend for stats nobody recorded — move the seed only with a
      // re-record.
      expect(shuffleInPlace(deck(), screenshotModeRandom())).toEqual(['f', 'c', 'h', 'a', 'd', 'g', 'e', 'b']);
      // …and again, from a generator made fresh.
      expect(shuffleInPlace(deck(), screenshotModeRandom())).toEqual(['f', 'c', 'h', 'a', 'd', 'g', 'e', 'b']);
    });

    it('picks the same refresh candidate every run', () => {
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
      const pool = deck().map((uuid) => makeClimb(uuid));
      const picked = () => pickRandomUnused(pool, new Set(), screenshotModeRandom())?.uuid;
      expect(picked()).toBe(picked());
    });
  });
});

describe('reshufflePools', () => {
  it('reorders a copy of every pool and leaves the originals alone', () => {
    const tens = ['a', 'b', 'c', 'd', 'e'].map(makeClimb);
    const elevens = ['f', 'g'].map(makeClimb);
    const pools = new Map([
      [key(10), tens],
      [key(11), elevens],
    ]);

    const reshuffled = reshufflePools(pools, mulberry32(7));

    expect(reshuffled).not.toBe(pools);
    expect(reshuffled.get(key(10))).not.toBe(tens);
    expect(pools.get(key(10))?.map((climb) => climb.uuid)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...(reshuffled.get(key(10)) ?? [])].map((climb) => climb.uuid).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...(reshuffled.get(key(11)) ?? [])].map((climb) => climb.uuid).sort()).toEqual(['f', 'g']);
  });
});
