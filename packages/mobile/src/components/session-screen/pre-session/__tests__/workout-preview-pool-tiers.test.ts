import { describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

const cryptoMock = vi.hoisted(() => {
  let n = 0;
  return { randomUUID: () => `qi-${n++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import { DEFAULT_WORKOUT_FILTERS } from '../workout-blocks';
import {
  buildPoolsReusing,
  fetchFilters,
  filtersSignature,
  pickRandomUnused,
  poolKeyForSlot,
  refreshSlotInState,
  reshufflePools,
  selectItemsFromPools,
  shuffleByTier,
  shuffleInPlace,
  NO_TOP_UPS,
  type FetchGradePool,
  type GradePool,
  type PreviewFetchContext,
  type PreviewFilters,
  type PreviewSlot,
  type TopUpTiers,
} from '../workout-preview-pool';
import { mulberry32 } from '../../../../lib/seeded-random';

const makeClimb = (uuid: string): Climb => ({ uuid, name: uuid }) as Climb;

const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard,
  isAuthenticated: true,
};

const slot = (grade: number, index: number, filters: PreviewFilters = DEFAULT_WORKOUT_FILTERS): PreviewSlot => ({
  grade,
  section: 'main',
  index,
  filters,
});

/**
 * A grade where you have not sent `unsent` climbs and have sent `sent`. The sent
 * ones are listed FIRST, as a quality sort can return them, so only the tiers
 * can put the unsent ones ahead.
 */
function poolWith(unsent: number, sent: number): GradePool {
  const sentClimbs = Array.from({ length: sent }, (_, index) => makeClimb(`sent-${index}`));
  const unsentClimbs = Array.from({ length: unsent }, (_, index) => makeClimb(`unsent-${index}`));
  return {
    climbs: [...sentClimbs, ...unsentClimbs],
    topUpTiers: new Map(sentClimbs.map((climb) => [climb.uuid, 2])),
  };
}

const isSent = (uuid: string) => uuid.startsWith('sent');

describe('filtersSignature', () => {
  it('is what it was before Skip sent and Benchmarks only for the default filters', () => {
    expect(filtersSignature(DEFAULT_WORKOUT_FILTERS)).toBe('5:2:false:false:unfamiliar');
    expect(filtersSignature({ ...DEFAULT_WORKOUT_FILTERS, skipSent: false, onlyBenchmarks: false })).toBe(
      '5:2:false:false:unfamiliar',
    );
  });

  it('gives each switch its own pool', () => {
    const skip = filtersSignature({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true });
    const benchmarks = filtersSignature({ ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true });
    const both = filtersSignature({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true, onlyBenchmarks: true });
    expect(new Set([filtersSignature(DEFAULT_WORKOUT_FILTERS), skip, benchmarks, both]).size).toBe(4);
  });
});

describe('fetchFilters', () => {
  it('drops Skip what I have sent signed out, so it shares the plain pool', () => {
    const skip = { ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' as const, skipSent: true };
    const neutral = fetchFilters(skip, false);
    expect(neutral).toEqual({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' });
    expect(filtersSignature(neutral)).toBe(filtersSignature({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' }));
  });

  it('keeps Benchmarks only signed out, and keeps everything signed in', () => {
    const benchmarks = { ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true, skipSent: true };
    expect(fetchFilters(benchmarks, false)?.onlyBenchmarks).toBe(true);
    expect(fetchFilters(benchmarks, true)).toBe(benchmarks);
  });

  it('hands back the same object when nothing needs neutralising', () => {
    const anyBias = { ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' as const };
    expect(fetchFilters(anyBias, false)).toBe(anyBias);
  });
});

describe('shuffleByTier', () => {
  it('shuffles inside each tier and keeps the tiers in order', () => {
    const { climbs, topUpTiers } = poolWith(20, 20);
    const tiers: TopUpTiers = new Map([...topUpTiers, ['unsent-0', 1]]);

    const shuffled = shuffleByTier(climbs, tiers, mulberry32(3));

    expect(shuffled).toHaveLength(40);
    expect(shuffled.slice(0, 19).every((climb) => climb.uuid.startsWith('unsent') && climb.uuid !== 'unsent-0')).toBe(
      true,
    );
    expect(shuffled[19].uuid).toBe('unsent-0');
    expect(shuffled.slice(20).every((climb) => isSent(climb.uuid))).toBe(true);
    // Mixed within the tier, and the input is left alone.
    expect(shuffled.slice(0, 19).map((climb) => climb.uuid)).not.toEqual(
      Array.from({ length: 19 }, (_, index) => `unsent-${index + 1}`),
    );
    expect(climbs[0].uuid).toBe('sent-0');
  });

  it('is the plain seeded shuffle when nothing is a top-up', () => {
    const climbs = Array.from({ length: 30 }, (_, index) => makeClimb(`climb-${index}`));
    expect(shuffleByTier(climbs, NO_TOP_UPS, mulberry32(9))).toEqual(shuffleInPlace(climbs.slice(), mulberry32(9)));
  });
});

describe('preferring climbs you have not sent', () => {
  it('fills from unsent climbs first and tops up with sent ones', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => poolWith(5, 30));
    const slots = Array.from({ length: 12 }, (_, index) => slot(15, index));

    const built = await buildPoolsReusing(slots, ctx, fetchPool);
    const { items } = selectItemsFromPools(slots, built.pools);

    const uuids = items.map((preview) => preview.item.climb.uuid);
    expect(uuids).toHaveLength(12);
    expect(uuids.slice(0, 5).every((uuid) => !isSent(uuid))).toBe(true);
    expect(uuids.slice(5).every(isSent)).toBe(true);
    expect(built.poolTopUpTiers.get(poolKeyForSlot(slots[0]))?.size).toBe(30);
  });

  it('never shows a sent climb while an unsent one is left', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => poolWith(40, 30));
    const slots = Array.from({ length: 20 }, (_, index) => slot(15, index));

    const { pools } = await buildPoolsReusing(slots, ctx, fetchPool);
    const { items } = selectItemsFromPools(slots, pools);

    expect(items.some((preview) => isSent(preview.item.climb.uuid))).toBe(false);
  });

  it('keeps the unsent climbs first through a whole-preview shuffle', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => poolWith(5, 30));
    const slots = Array.from({ length: 8 }, (_, index) => slot(15, index));
    const built = await buildPoolsReusing(slots, ctx, fetchPool);

    for (let seed = 1; seed <= 5; seed++) {
      const pools = reshufflePools(built.pools, built.poolTopUpTiers, mulberry32(seed));
      const { items } = selectItemsFromPools(slots, pools);
      const unsentShown = items.filter((preview) => !isSent(preview.item.climb.uuid));
      expect(unsentShown).toHaveLength(5);
      expect(items.slice(0, 5)).toEqual(unsentShown);
    }
  });

  it('carries a reused pool’s top-ups into the rebuild', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => poolWith(5, 30));
    const slots = Array.from({ length: 8 }, (_, index) => slot(15, index));
    const first = await buildPoolsReusing(slots, ctx, fetchPool);

    const rebuilt = await buildPoolsReusing(slots, ctx, fetchPool, first);

    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(rebuilt.poolTopUpTiers).toEqual(first.poolTopUpTiers);
  });

  it('keeps unrated climbs: nothing on the phone drops a climb with no rating', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => ({
      // No one has rated these yet: the search reports a 0 average and 0 stars.
      climbs: ['unrated-a', 'unrated-b'].map((uuid) => ({ ...makeClimb(uuid), quality_average: '0', stars: 0 })),
      topUpTiers: NO_TOP_UPS,
    }));
    const slots = [
      slot(15, 0, { ...DEFAULT_WORKOUT_FILTERS, minRating: 0 }),
      slot(15, 1, { ...DEFAULT_WORKOUT_FILTERS, minRating: 0 }),
    ];

    const { pools } = await buildPoolsReusing(slots, ctx, fetchPool);

    expect(selectItemsFromPools(slots, pools).items).toHaveLength(2);
  });
});

describe('pickRandomUnused with tiers', () => {
  it('picks only from the earliest tier that has an unused climb', () => {
    const { climbs, topUpTiers } = poolWith(3, 10);
    for (let seed = 1; seed <= 10; seed++) {
      const pick = pickRandomUnused(climbs, new Set(['unsent-0']), mulberry32(seed), topUpTiers);
      expect(pick && !isSent(pick.uuid)).toBe(true);
    }
    const allUnsentShown = new Set(['unsent-0', 'unsent-1', 'unsent-2']);
    expect(isSent(pickRandomUnused(climbs, allUnsentShown, mulberry32(1), topUpTiers)?.uuid ?? '')).toBe(true);
  });
});

describe('refreshSlotInState with top-ups', () => {
  /** Two rows at one grade showing `shown`, drawn from `pool`. */
  function twoRows(pool: GradePool, shown: [string, string]) {
    const slots = [slot(15, 0), slot(15, 1)];
    const key = poolKeyForSlot(slots[0]);
    const byUuid = new Map(pool.climbs.map((climb) => [climb.uuid, climb]));
    const shownClimbs = shown.map((uuid) => byUuid.get(uuid) as Climb);
    const rest = pool.climbs.filter((climb) => !shown.includes(climb.uuid));
    const pools = new Map([[key, [...shownClimbs, ...rest]]]);
    const { items, usedUuids } = selectItemsFromPools(slots, pools);
    return { items, pools, usedUuids, poolTopUpTiers: new Map([[key, pool.topUpTiers]]) };
  }

  it('swaps a sent row for an unsent climb while one is free', async () => {
    const state = twoRows(poolWith(3, 10), ['unsent-0', 'sent-0']);
    const fetchPool = vi.fn<FetchGradePool>();

    for (let attempt = 0; attempt < 5; attempt++) {
      const { state: next } = await refreshSlotInState(state, state.items[1].item.uuid, ctx, fetchPool);
      expect(['unsent-1', 'unsent-2']).toContain(next.items[1].item.climb.uuid);
    }
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('tops up from the sent climbs once every unsent one is on screen, without refetching', async () => {
    const state = twoRows(poolWith(2, 10), ['unsent-0', 'unsent-1']);
    const fetchPool = vi.fn<FetchGradePool>();

    const { state: next } = await refreshSlotInState(state, state.items[0].item.uuid, ctx, fetchPool);

    expect(isSent(next.items[0].item.climb.uuid)).toBe(true);
    expect(fetchPool).not.toHaveBeenCalled();
  });

  it('keeps the refetched pool’s top-ups for the next refresh', async () => {
    const slots = [slot(15, 0)];
    const key = poolKeyForSlot(slots[0]);
    const pools = new Map([[key, [makeClimb('only')]]]);
    const { items, usedUuids } = selectItemsFromPools(slots, pools);
    const fetchPool = vi.fn<FetchGradePool>(async () => poolWith(1, 5));

    const { state, changed } = await refreshSlotInState(
      { items, pools, usedUuids },
      items[0].item.uuid,
      ctx,
      fetchPool,
    );

    expect(changed).toBe(true);
    expect(state.items[0].item.climb.uuid).toBe('unsent-0');
    expect(state.poolTopUpTiers?.get(key)?.size).toBe(5);
  });
});

describe('pools that hold every climb their grade has', () => {
  /** Two climbs at grade 15: all the catalogue has under these filters. */
  const thinPool = (): GradePool => ({
    climbs: [makeClimb('thin-0'), makeClimb('thin-1')],
    topUpTiers: NO_TOP_UPS,
    exhausted: true,
  });

  it('reuses a short pool whatever the demand, so editing the plan does not search again', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => thinPool());
    let built = await buildPoolsReusing([slot(15, 0), slot(15, 1), slot(15, 2)], ctx, fetchPool);
    expect(built.exhaustedPoolKeys.has(poolKeyForSlot(slot(15, 0)))).toBe(true);

    for (let slotCount = 3; slotCount <= 8; slotCount++) {
      const slots = Array.from({ length: slotCount }, (_, index) => slot(15, index));
      built = await buildPoolsReusing(slots, ctx, fetchPool, built);
    }

    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(
      built.pools
        .get(poolKeyForSlot(slot(15, 0)))
        ?.map((climb) => climb.uuid)
        .sort(),
    ).toEqual(['thin-0', 'thin-1']);
  });

  it('still refetches a short pool that may have more', async () => {
    const fetchPool = vi.fn<FetchGradePool>(async () => ({ ...thinPool(), exhausted: false }));
    const slots = [slot(15, 0), slot(15, 1), slot(15, 2)];
    const first = await buildPoolsReusing(slots, ctx, fetchPool);

    await buildPoolsReusing(slots, ctx, fetchPool, first);

    expect(first.exhaustedPoolKeys.size).toBe(0);
    expect(fetchPool).toHaveBeenCalledTimes(2);
  });

  it('records whether a refresh refetch read the grade out', async () => {
    const slots = [slot(15, 0)];
    const key = poolKeyForSlot(slots[0]);
    const pools = new Map([[key, [makeClimb('only')]]]);
    const { items, usedUuids } = selectItemsFromPools(slots, pools);
    const fetchPool = vi.fn<FetchGradePool>(async () => thinPool());

    const { state } = await refreshSlotInState({ items, pools, usedUuids }, items[0].item.uuid, ctx, fetchPool);

    expect(state.exhaustedPoolKeys?.has(key)).toBe(true);
  });

  it('leaves the shared pools alone when a refresh is superseded mid-fetch', async () => {
    const slots = [slot(15, 0)];
    const key = poolKeyForSlot(slots[0]);
    const cachedPool = [makeClimb('only')];
    const pools = new Map([[key, cachedPool]]);
    const poolDemands = new Map([[key, 1]]);
    const { items, usedUuids } = selectItemsFromPools(slots, pools);
    let current = true;
    const fetchPool = vi.fn<FetchGradePool>(async () => {
      current = false; // the climber edits the plan while the refresh is out
      return thinPool();
    });

    const result = await refreshSlotInState(
      { items, pools, usedUuids, poolDemands },
      items[0].item.uuid,
      { ...ctx, isCurrent: () => current },
      fetchPool,
    );

    expect(result.changed).toBe(false);
    expect(pools.get(key)).toBe(cachedPool);
    expect(poolDemands.get(key)).toBe(1);
  });
});
