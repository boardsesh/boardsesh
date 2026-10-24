import { describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

const cryptoMock = vi.hoisted(() => {
  let n = 0;
  return { randomUUID: () => `qi-${n++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import { DEFAULT_WORKOUT_FILTERS, filtersOf, sameFilters } from '../workout-blocks';
import {
  buildPoolsReusing,
  fetchFilters,
  filtersSignature,
  refreshSlotInState,
  selectItemsFromPools,
  type FetchGradePool,
  type GradePool,
  type PreviewFetchContext,
  type PreviewFilters,
  type PreviewSlot,
} from '../workout-preview-pool';
import {
  SEARCH_TIERS_BY_BIAS,
  biasCanSkipTried,
  searchTiers,
  tierAscentStatus,
  type ClimbSearchTier,
} from '../workout-search-tiers';

const UNTRIED: ClimbSearchTier = { hideAttempted: true, hideCompleted: true };
const skipTried = (filters: Partial<PreviewFilters> = {}): PreviewFilters => ({
  ...DEFAULT_WORKOUT_FILTERS,
  skipTried: true,
  ...filters,
});

describe('the bias to tier table', () => {
  it('gives each bias its searches and what each skip switch leaves of them', () => {
    const flags = (rules: ReadonlyArray<{ flags: ClimbSearchTier }> | null) => rules?.map((rule) => rule.flags) ?? null;
    expect(
      Object.fromEntries(
        Object.entries(SEARCH_TIERS_BY_BIAS).map(([bias, tiers]) => [
          bias,
          {
            all: flags(tiers.all),
            unsent: flags(tiers.unsent),
            untried: flags(tiers.untried),
            dropsFloors: tiers.dropsFloors,
          },
        ]),
      ),
    ).toEqual({
      unfamiliar: {
        all: [UNTRIED, { hideCompleted: true }, {}],
        unsent: [UNTRIED, { hideCompleted: true }],
        untried: [UNTRIED],
        dropsFloors: false,
      },
      attempted: {
        all: [{ showOnlyAttempted: true }],
        unsent: [{ showOnlyAttempted: true, hideCompleted: true }],
        untried: null,
        dropsFloors: false,
      },
      sent: { all: [{ showOnlyCompleted: true }], unsent: null, untried: null, dropsFloors: true },
      liked: {
        all: [{ onlyFavorited: true }],
        unsent: [{ onlyFavorited: true, hideCompleted: true }],
        untried: [{ onlyFavorited: true, ...UNTRIED }],
        dropsFloors: true,
      },
      any: { all: [{}], unsent: [{ hideCompleted: true }], untried: [UNTRIED], dropsFloors: false },
    });
  });

  it('only ever narrows: a skip switch keeps searches that hide what it skips', () => {
    for (const tiers of Object.values(SEARCH_TIERS_BY_BIAS)) {
      expect(tiers.unsent?.every((rule) => rule.flags.hideCompleted) ?? true).toBe(true);
      expect(tiers.untried?.every((rule) => rule.flags.hideAttempted && rule.flags.hideCompleted) ?? true).toBe(true);
    }
  });
});

describe("Skip what I've tried", () => {
  it('keeps Unfamiliar to climbs you have never tried, with or without Skip sent', () => {
    expect(searchTiers(skipTried(), true)).toEqual([UNTRIED]);
    expect(searchTiers(skipTried({ skipSent: true }), true)).toEqual([UNTRIED]);
  });

  it('swaps Any for the never-tried search', () => {
    expect(searchTiers(skipTried({ climbBias: 'any' }), true)).toEqual([UNTRIED]);
  });

  it('does nothing under Attempted, which picks tried climbs', () => {
    expect(biasCanSkipTried('attempted')).toBe(false);
    expect(biasCanSkipTried('unfamiliar')).toBe(true);
    expect(biasCanSkipTried('any')).toBe(true);
    expect(searchTiers(skipTried({ climbBias: 'attempted' }), true)).toEqual([{ showOnlyAttempted: true }]);
    expect(searchTiers(skipTried({ climbBias: 'attempted', skipSent: true }), true)).toEqual([
      { showOnlyAttempted: true, hideCompleted: true },
    ]);
  });

  it('reads no logbook signed out', () => {
    expect(searchTiers(skipTried(), false)).toEqual([{}]);
  });

  it('is left off stored filters when off, and pools apart when on', () => {
    expect(filtersOf({ ...DEFAULT_WORKOUT_FILTERS, skipTried: false })).not.toHaveProperty('skipTried');
    expect(filtersOf(skipTried())).toMatchObject({ skipTried: true });
    expect(sameFilters(DEFAULT_WORKOUT_FILTERS, { ...DEFAULT_WORKOUT_FILTERS, skipTried: false })).toBe(true);
    expect(sameFilters(DEFAULT_WORKOUT_FILTERS, skipTried())).toBe(false);
    expect(filtersSignature({ ...DEFAULT_WORKOUT_FILTERS, skipTried: false })).toBe('5:2:false:false:unfamiliar');
    expect(filtersSignature(skipTried())).toBe('5:2:false:false:unfamiliar:skipTried');
  });

  it('is dropped from the fetch where it cannot apply', () => {
    const signedOut = fetchFilters(skipTried({ skipSent: true }), false);
    expect(signedOut).toEqual({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' });
    const attempted = skipTried({ climbBias: 'attempted' });
    expect(fetchFilters(attempted, true)).toEqual({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'attempted' });
    const unfamiliar = skipTried();
    expect(fetchFilters(unfamiliar, true)).toBe(unfamiliar);
  });
});

describe('tierAscentStatus', () => {
  it('names what the Unfamiliar top-ups are: tried and not sent, then sent', () => {
    expect([0, 1, 2].map((tier) => tierAscentStatus(DEFAULT_WORKOUT_FILTERS, tier))).toEqual([null, 'attempt', 'send']);
  });

  it('names a climb only where the search pins it down', () => {
    const attempted = { ...DEFAULT_WORKOUT_FILTERS, climbBias: 'attempted' as const };
    // Tried, but maybe sent too.
    expect(tierAscentStatus(attempted, 0)).toBeNull();
    expect(tierAscentStatus({ ...attempted, skipSent: true }, 0)).toBe('attempt');
    expect(tierAscentStatus({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any' }, 0)).toBeNull();
    expect(tierAscentStatus({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'any', skipSent: true }, 0)).toBeNull();
    expect(tierAscentStatus(skipTried(), 0)).toBeNull();
    expect(tierAscentStatus(undefined, 0)).toBeNull();
    expect(tierAscentStatus(DEFAULT_WORKOUT_FILTERS, 3)).toBeNull();
  });
});

const makeClimb = (uuid: string): Climb => ({ uuid, name: uuid }) as Climb;
const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 } as UserBoard,
  isAuthenticated: true,
};
const slot = (index: number, filters: PreviewFilters = DEFAULT_WORKOUT_FILTERS): PreviewSlot => ({
  grade: 20,
  section: 'main',
  index,
  filters,
});

/** Two never-tried climbs, then a tried-not-sent top-up and a sent one, like Pinball in simulator QA. */
const shortGrade = (): GradePool => ({
  climbs: ['fresh-0', 'fresh-1', 'project', 'pinball'].map(makeClimb),
  topUpTiers: new Map([
    ['project', 1],
    ['pinball', 2],
  ]),
  exhausted: true,
});

describe('preview rows carry the mark their search proves', () => {
  it('marks a sent top-up sent and a tried one tried, with no logbook', async () => {
    const slots = [0, 1, 2, 3].map((index) => slot(index));
    const built = await buildPoolsReusing(
      slots,
      ctx,
      vi.fn<FetchGradePool>(async () => shortGrade()),
    );

    const { items } = selectItemsFromPools(slots, built.pools, undefined, undefined, built.poolTopUpTiers);

    const marks = Object.fromEntries(items.map((preview) => [preview.item.climb.uuid, preview.knownStatus]));
    expect(marks).toEqual({ 'fresh-0': undefined, 'fresh-1': undefined, project: 'attempt', pinball: 'send' });
  });

  it('keeps the mark on a row a rebuild keeps', async () => {
    const slots = [0, 1, 2, 3].map((index) => slot(index));
    const built = await buildPoolsReusing(
      slots,
      ctx,
      vi.fn<FetchGradePool>(async () => shortGrade()),
    );
    const first = selectItemsFromPools(slots, built.pools, undefined, undefined, built.poolTopUpTiers);

    const kept = selectItemsFromPools(
      slots,
      built.pools,
      undefined,
      first.items.map((preview) => preview.item),
      built.poolTopUpTiers,
    );

    expect(kept.items.find((preview) => preview.item.climb.uuid === 'pinball')?.knownStatus).toBe('send');
  });

  it('gives a refreshed row the mark of the climb it lands on', async () => {
    const slots = [slot(0)];
    const pool: GradePool = {
      climbs: [makeClimb('fresh-0'), makeClimb('pinball')],
      topUpTiers: new Map([['pinball', 2]]),
      exhausted: true,
    };
    const fetchPool = vi.fn<FetchGradePool>(async () => pool);
    const built = await buildPoolsReusing(slots, ctx, fetchPool);
    const { items, usedUuids } = selectItemsFromPools(slots, built.pools, undefined, undefined, built.poolTopUpTiers);
    expect(items[0].item.climb.uuid).toBe('fresh-0');

    const { state, changed } = await refreshSlotInState(
      { ...built, items, usedUuids },
      items[0].item.uuid,
      ctx,
      fetchPool,
    );

    expect(changed).toBe(true);
    expect(state.items[0].item.climb.uuid).toBe('pinball');
    expect(state.items[0].knownStatus).toBe('send');
  });

  it('marks nothing signed out, where the pool is one plain search', async () => {
    const signedOutFilters = fetchFilters(DEFAULT_WORKOUT_FILTERS, false);
    const slots = [0, 1].map((index) => slot(index, signedOutFilters));
    const built = await buildPoolsReusing(
      slots,
      { ...ctx, isAuthenticated: false },
      vi.fn<FetchGradePool>(async () => ({ climbs: [makeClimb('a'), makeClimb('b')], topUpTiers: new Map() })),
    );

    const { items } = selectItemsFromPools(slots, built.pools, undefined, undefined, built.poolTopUpTiers);

    expect(items.every((preview) => preview.knownStatus === undefined)).toBe(true);
  });
});
