import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbBias } from '@boardsesh/playlist-generator';
import type { Climb, ClimbSearchInput, UserBoard } from '@boardsesh/shared-schema';
import { DEFAULT_WORKOUT_FILTERS } from '../workout-blocks';
import { fetchFilters, type PreviewFetchContext, type PreviewFilters } from '../workout-preview-pool';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'qi-0' }));
vi.mock('../../../../lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));

import { offlineAwareRequest } from '../../../../lib/graphql/offline-request';
import { buildClimbSearchInput, fetchGradePool } from '../select-climbs-for-plan';

const offlineAwareRequestMock = vi.mocked(offlineAwareRequest);

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 } as UserBoard;

/** The context a preview fetch runs with: the block's filters as `fetchFilters` hands them on. */
function fetchContext(
  climbBias: ClimbBias,
  isAuthenticated: boolean,
  extra: Partial<PreviewFilters> = {},
): PreviewFetchContext {
  return {
    board,
    isAuthenticated,
    filters: fetchFilters({ ...DEFAULT_WORKOUT_FILTERS, climbBias, ...extra }, isAuthenticated),
  };
}

const PERSONAL_FLAGS = [
  'hideAttempted',
  'hideCompleted',
  'showOnlyAttempted',
  'showOnlyCompleted',
  'onlyFavorited',
] as const satisfies ReadonlyArray<keyof ClimbSearchInput>;

function personalFlags(input: ClimbSearchInput): Partial<Record<(typeof PERSONAL_FLAGS)[number], true>> {
  return Object.fromEntries(PERSONAL_FLAGS.filter((flag) => input[flag]).map((flag) => [flag, true]));
}

beforeEach(() => {
  offlineAwareRequestMock.mockReset();
});

describe('the search a block drawn from your own climbs sends', () => {
  it('asks for the climbs you have sent at the angle, with no crowd floor', () => {
    const input = buildClimbSearchInput(20, fetchContext('sent', true));

    expect(personalFlags(input)).toEqual({ showOnlyCompleted: true });
    expect(input).toMatchObject({ angle: 40, minGrade: 20, maxGrade: 20, minAscents: 0, minRating: 0 });
  });

  it('asks for the climbs you have liked, and narrows them with the skip switches', () => {
    expect(personalFlags(buildClimbSearchInput(20, fetchContext('liked', true)))).toEqual({ onlyFavorited: true });
    expect(personalFlags(buildClimbSearchInput(20, fetchContext('liked', true, { skipSent: true })))).toEqual({
      onlyFavorited: true,
      hideCompleted: true,
    });
    expect(buildClimbSearchInput(20, fetchContext('liked', true))).toMatchObject({ minAscents: 0, minRating: 0 });
  });

  it('keeps Benchmarks only on a liked block', () => {
    expect(buildClimbSearchInput(20, fetchContext('liked', true, { onlyBenchmarks: true }))).toMatchObject({
      onlyFavorited: true,
      onlyBenchmarks: true,
    });
  });

  it('sends no personal flag signed out, and keeps the default floors', () => {
    for (const climbBias of ['attempted', 'sent', 'liked'] as const) {
      const input = buildClimbSearchInput(20, fetchContext(climbBias, false));
      expect(personalFlags(input)).toEqual({});
      expect(input).toMatchObject({ minAscents: 5, minRating: 2 });
    }
  });
});

describe('fetchGradePool for a block drawn from your own climbs', () => {
  it('reads one search, and holds the whole list when it runs out', async () => {
    const sentClimbs = ['crimp-ladder', 'pinball'].map((uuid) => ({ uuid, name: uuid }) as Climb);
    offlineAwareRequestMock.mockResolvedValue({ searchClimbs: { climbs: sentClimbs, hasMore: false } });

    const pool = await fetchGradePool(20, fetchContext('sent', true), 6);

    expect(offlineAwareRequestMock).toHaveBeenCalledTimes(1);
    expect(pool.climbs.map((climb) => climb.uuid)).toEqual(['crimp-ladder', 'pinball']);
    expect(pool.topUpTiers.size).toBe(0);
    // A short list is the whole list: a rebuild reuses it instead of asking again.
    expect(pool.exhausted).toBe(true);
  });

  it('comes back empty when you have liked nothing at the grade', async () => {
    offlineAwareRequestMock.mockResolvedValue({ searchClimbs: { climbs: [], hasMore: false } });

    const pool = await fetchGradePool(20, fetchContext('liked', true), 4);

    expect(pool.climbs).toEqual([]);
    expect(pool.exhausted).toBe(true);
  });
});
