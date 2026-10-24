import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test';
import type { ClimbSearchInput, ConnectionContext } from '@boardsesh/shared-schema';
import type { ClimbSearchParams } from '../../../../db/queries/climbs/index';

/**
 * Issue #5412: `crossAngleStats: true` turns the climb search into a query that
 * ranks the whole layout before it cuts a page (~5.6 s on Kilter, ~0.9 s on
 * MoonBoard, measured on production). The mobile flag that sends it sits at 0%,
 * but nothing stopped a client from sending it anyway. The server now honours it
 * only on boards `CROSS_ANGLE_STATS_BOARDS` names, and on Woods, where it is the
 * climber's own switch.
 *
 * The second half pins WHERE the gate sits: the list, the count and the Redis
 * cache key must all read the gated params, or one of them would still run (or
 * cache) the cross-angle query the others refused.
 */

const { searchClimbsMock, countClimbsMock } = vi.hoisted(() => ({
  searchClimbsMock: vi.fn(),
  countClimbsMock: vi.fn(),
}));

// String form, not `vi.mock(import(...))`: only the two query functions are
// replaced, and `mapSearchInputToParams` must stay real so the resolver builds
// the params exactly as it does in production.
vi.mock('../../../../db/queries/climbs/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../db/queries/climbs/index')>()),
  searchClimbs: searchClimbsMock,
  countClimbs: countClimbsMock,
}));

import {
  CROSS_ANGLE_STATS_BOARDS_ENV,
  gateCrossAngleStats,
  isCrossAngleStatsEnabledForBoard,
} from '../cross-angle-gate';
import { climbQueries } from '../queries';
import { climbFieldResolvers } from '../field-resolvers';
import type { ClimbSearchContext } from '../../shared/types';
import { searchCache } from '../../../../services/search-cache';

const OPT_IN: ClimbSearchParams = {
  page: 0,
  pageSize: 20,
  sortBy: 'ascents',
  sortOrder: 'desc',
  crossAngleStats: true,
};

describe('gateCrossAngleStats (#5412)', () => {
  it.each(['kilter', 'tension', 'moonboard', 'spray'])(
    'drops the opt-in on %s when the server has not switched it on',
    (boardName) => {
      expect(gateCrossAngleStats(boardName, OPT_IN, undefined).crossAngleStats).toBe(false);
      expect(gateCrossAngleStats(boardName, OPT_IN, '').crossAngleStats).toBe(false);
      expect(gateCrossAngleStats(boardName, OPT_IN, ' , ').crossAngleStats).toBe(false);
    },
  );

  it('drops it on a board the setting does not name', () => {
    expect(gateCrossAngleStats('kilter', OPT_IN, 'moonboard').crossAngleStats).toBe(false);
  });

  it('keeps it on a board the setting names, whatever the case and spacing', () => {
    expect(gateCrossAngleStats('kilter', OPT_IN, ' MoonBoard , Kilter ').crossAngleStats).toBe(true);
    expect(gateCrossAngleStats('moonboard', OPT_IN, 'moonboard').crossAngleStats).toBe(true);
  });

  it('keeps it on every board with `*`, which is the behaviour before the gate', () => {
    for (const boardName of ['kilter', 'tension', 'moonboard', 'spray']) {
      expect(gateCrossAngleStats(boardName, OPT_IN, '*').crossAngleStats).toBe(true);
    }
  });

  it("always keeps it on Woods, where it is the climber's own Other angles switch", () => {
    expect(gateCrossAngleStats('woods', OPT_IN, undefined)).toBe(OPT_IN);
    expect(gateCrossAngleStats('woods', OPT_IN, 'kilter')).toBe(OPT_IN);
  });

  it('leaves every other field alone and does not mutate its input', () => {
    const gated = gateCrossAngleStats('kilter', { ...OPT_IN, minGrade: 16, name: 'crimp' }, undefined);
    expect(gated).toEqual({ ...OPT_IN, minGrade: 16, name: 'crimp', crossAngleStats: false });
    expect(OPT_IN.crossAngleStats).toBe(true);
  });

  it('returns the same params when the search did not opt in', () => {
    const withFalse: ClimbSearchParams = { ...OPT_IN, crossAngleStats: false };
    const withoutField: ClimbSearchParams = { page: 0, pageSize: 20 };
    expect(gateCrossAngleStats('kilter', withFalse, undefined)).toBe(withFalse);
    expect(gateCrossAngleStats('kilter', withoutField, undefined)).toBe(withoutField);
  });

  it(`reads ${CROSS_ANGLE_STATS_BOARDS_ENV} when no setting is passed`, () => {
    vi.stubEnv(CROSS_ANGLE_STATS_BOARDS_ENV, 'tension');
    try {
      expect(gateCrossAngleStats('tension', OPT_IN).crossAngleStats).toBe(true);
      expect(gateCrossAngleStats('kilter', OPT_IN).crossAngleStats).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('parses the setting as a comma-separated board list', () => {
    expect(isCrossAngleStatsEnabledForBoard('kilter', 'kilter')).toBe(true);
    expect(isCrossAngleStatsEnabledForBoard('kilter', 'kilterx')).toBe(false);
    expect(isCrossAngleStatsEnabledForBoard('kilter', undefined)).toBe(false);
  });
});

describe('searchClimbs resolver: the list, the count and the cache key read the gated params (#5412)', () => {
  const anonymous = {
    isAuthenticated: false,
    userId: undefined,
    connectionId: 'cross-angle-gate-anon',
  } as ConnectionContext;

  const KILTER: ClimbSearchInput = {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    page: 0,
    pageSize: 20,
    sortBy: 'ascents',
    sortOrder: 'desc',
  };
  const MOONBOARD: ClimbSearchInput = { ...KILTER, boardName: 'moonboard', layoutId: 2, sizeId: 17, setIds: '1' };
  const WOODS: ClimbSearchInput = { ...KILTER, boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 30 };

  let buildCacheKeySpy: MockInstance<(typeof searchCache)['buildCacheKey']>;

  beforeEach(() => {
    vi.stubEnv(CROSS_ANGLE_STATS_BOARDS_ENV, '');
    searchClimbsMock.mockReset().mockResolvedValue({ climbs: [], hasMore: false });
    countClimbsMock.mockReset().mockResolvedValue(0);
    buildCacheKeySpy = vi.spyOn(searchCache, 'buildCacheKey');
    // Never serve or store a page: a CI Redis must not answer for the query mock.
    vi.spyOn(searchCache, 'getCachedResult').mockResolvedValue(null);
    vi.spyOn(searchCache, 'setCachedResult').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Runs the resolver, then the two field resolvers that hit the database. */
  async function search(input: ClimbSearchInput): Promise<ClimbSearchContext> {
    const context = await climbQueries.searchClimbs(null, { input }, anonymous);
    await climbFieldResolvers.climbs(context);
    await climbFieldResolvers.totalCount(context);
    return context;
  }

  /** The `crossAngleStats` the list query, the count query and every cache key were built from. */
  function crossAngleSeenDownstream() {
    return {
      list: searchClimbsMock.mock.calls.map(([, searchParams]) => (searchParams as ClimbSearchParams).crossAngleStats),
      count: countClimbsMock.mock.calls.map(([, searchParams]) => (searchParams as ClimbSearchParams).crossAngleStats),
      cacheKeys: buildCacheKeySpy.mock.calls.map(([, searchParams]) => searchParams.crossAngleStats),
    };
  }

  it('turns a Kilter opt-in off for the list, the count and both cache keys', async () => {
    const context = await search({ ...KILTER, crossAngleStats: true });

    expect(context._isCacheable).toBe(true);
    expect(context.searchParams.crossAngleStats).toBe(false);
    expect(crossAngleSeenDownstream()).toEqual({ list: [false], count: [false], cacheKeys: [false, false] });
  });

  it('caches a gated Kilter search under the same keys as the plain search it became', async () => {
    await search({ ...KILTER, crossAngleStats: true });
    await search({ ...KILTER, crossAngleStats: false });

    const [gatedClimbsKey, gatedCountKey, plainClimbsKey, plainCountKey] = buildCacheKeySpy.mock.results.map(
      (result) => result.value,
    );
    expect(gatedClimbsKey).toBe(plainClimbsKey);
    expect(gatedCountKey).toBe(plainCountKey);
  });

  it('turns a MoonBoard opt-in off on the uncached path too', async () => {
    const context = await search({ ...MOONBOARD, crossAngleStats: true });

    expect(context._isCacheable).toBe(false);
    expect(crossAngleSeenDownstream()).toEqual({ list: [false], count: [false], cacheKeys: [] });
  });

  it('passes the opt-in through on a board the setting names', async () => {
    vi.stubEnv(CROSS_ANGLE_STATS_BOARDS_ENV, 'kilter');
    const context = await search({ ...KILTER, crossAngleStats: true });

    expect(context.searchParams.crossAngleStats).toBe(true);
    expect(crossAngleSeenDownstream()).toEqual({ list: [true], count: [true], cacheKeys: [true, true] });
  });

  it("passes Woods' Other angles switch through with nothing set", async () => {
    const context = await search({ ...WOODS, crossAngleStats: true });

    expect(context.searchParams.crossAngleStats).toBe(true);
    expect(crossAngleSeenDownstream()).toEqual({ list: [true], count: [true], cacheKeys: [] });
  });
});
