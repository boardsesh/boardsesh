import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { USER_SPECIFIC_SEARCH_PARAMS } from '@boardsesh/shared-schema';

/**
 * C9, first half: the popular sort re-runs a layout-wide ascent aggregate on
 * every page (about 1.5 s and 125k buffers on the replica, 20 s on prod), so a
 * viewer-independent popular page is read through Redis with single-flight on
 * the miss. A page that depends on the viewer must never be shared.
 */

const { searchClimbsMock, countClimbsMock, redisStore, redisState, getMock, setMock, loggerErrorMock } = vi.hoisted(
  () => ({
    searchClimbsMock: vi.fn(),
    countClimbsMock: vi.fn(),
    redisStore: new Map<string, string>(),
    redisState: { connected: true },
    getMock: vi.fn(),
    setMock: vi.fn(),
    loggerErrorMock: vi.fn(),
  }),
);

vi.mock('../../../../db/queries/climbs/index', () => ({
  searchClimbs: searchClimbsMock,
  countClimbs: countClimbsMock,
}));

vi.mock('../../../../utils/logger', () => ({
  logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisState.connected,
    getClients: () => ({ publisher: { get: getMock, set: setMock } }),
  },
}));

import { climbFieldResolvers } from '../field-resolvers';
import {
  isPopularPageCacheable,
  popularPageCacheSlot,
  POPULAR_PAGE_CACHE_TTL_SECONDS,
  readPopularPage,
  type PopularPage,
} from '../popular-page-cache';
import { DEFAULT_SEARCH_CACHE_TTL } from '../../../../services/search-cache';
import { resetSingleFlightForTests } from '../../../../utils/single-flight';
import type { ClimbSearchContext } from '../../shared/types';
import type { ClimbSearchParams, ParsedBoardRouteParameters } from '../../../../db/queries/climbs/index';

const PAGE: PopularPage = {
  climbs: [{ uuid: 'CLIMB-1', name: 'Popular one' }] as unknown as PopularPage['climbs'],
  hasMore: true,
};

function routeParams(overrides: Partial<ParsedBoardRouteParameters> = {}): ParsedBoardRouteParameters {
  return {
    board_name: 'moonboard' as ParsedBoardRouteParameters['board_name'],
    layout_id: 3,
    size_id: 1,
    set_ids: [5, 4],
    angle: 40,
    ...overrides,
  };
}

function popularParams(overrides: ClimbSearchParams = {}): ClimbSearchParams {
  return { sortBy: 'popular', sortOrder: 'desc', page: 0, pageSize: 20, ...overrides };
}

function contextFor(overrides: Partial<ClimbSearchContext> = {}): ClimbSearchContext {
  return {
    params: routeParams(),
    searchParams: popularParams(),
    userId: undefined,
    _isCacheable: false,
    _isPopularPageCacheable: true,
    ...overrides,
  };
}

describe('popular page cache', () => {
  beforeEach(() => {
    redisStore.clear();
    redisState.connected = true;
    searchClimbsMock.mockReset();
    searchClimbsMock.mockResolvedValue(PAGE);
    countClimbsMock.mockReset();
    loggerErrorMock.mockReset();
    getMock.mockReset();
    getMock.mockImplementation(async (key: string) => redisStore.get(key) ?? null);
    setMock.mockReset();
    setMock.mockImplementation(async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    });
    resetSingleFlightForTests();
  });

  afterEach(() => {
    resetSingleFlightForTests();
  });

  describe('isPopularPageCacheable', () => {
    it('accepts a popular page with no user-specific filter, on MoonBoard, Woods and Kilter', () => {
      for (const boardName of ['moonboard', 'woods', 'kilter']) {
        expect(isPopularPageCacheable(boardName, popularParams({ minGrade: 16, name: 'crimp' })), boardName).toBe(true);
      }
    });

    it('rejects every other sort', () => {
      for (const sortBy of ['ascents', 'quality', 'difficulty', 'name', 'creation', 'random'] as const) {
        expect(isPopularPageCacheable('kilter', { sortBy }), sortBy).toBe(false);
      }
    });

    it('rejects spray walls, whose pages are private per wall', () => {
      expect(isPopularPageCacheable('spray', popularParams())).toBe(false);
    });

    it('rejects a search carrying any user-specific filter', () => {
      expect(USER_SPECIFIC_SEARCH_PARAMS.length).toBeGreaterThan(0);
      for (const param of USER_SPECIFIC_SEARCH_PARAMS) {
        const withParam = { ...popularParams(), [param]: param === 'minUserRating' ? 3 : true } as ClimbSearchParams;
        expect(isPopularPageCacheable('kilter', withParam), param).toBe(false);
      }
    });
  });

  describe('popularPageCacheSlot', () => {
    it('keeps the 24 h search-cache key and TTL where that cache already applies', () => {
      const slot = popularPageCacheSlot(routeParams({ board_name: 'kilter' }), popularParams(), true);
      expect(slot.key).toContain(':climbs:kilter:');
      expect(slot.ttlSeconds).toBe(DEFAULT_SEARCH_CACHE_TTL);
    });

    it('uses a separate ten-minute key everywhere else', () => {
      const slot = popularPageCacheSlot(routeParams(), popularParams(), false);
      expect(slot.key).toContain(':popular-page:moonboard:3:1:4,5:40:');
      expect(slot.ttlSeconds).toBe(POPULAR_PAGE_CACHE_TTL_SECONDS);
      expect(POPULAR_PAGE_CACHE_TTL_SECONDS).toBe(600);
    });

    it('changes with every input that changes the page', () => {
      const base = popularPageCacheSlot(routeParams(), popularParams(), false).key;
      const variants: Array<[Partial<ParsedBoardRouteParameters>, ClimbSearchParams]> = [
        [{ angle: 25 }, {}],
        [{ layout_id: 4 }, {}],
        [{ size_id: 2 }, {}],
        [{ set_ids: [5] }, {}],
        [{}, { page: 1 }],
        [{}, { pageSize: 40 }],
        [{}, { sortOrder: 'asc' }],
        [{}, { minGrade: 16, maxGrade: 20 }],
        [{}, { minAscents: 5 }],
        [{}, { name: 'crimp' }],
      ];
      const keys = variants.map(
        ([route, search]) => popularPageCacheSlot(routeParams(route), popularParams(search), false).key,
      );
      expect(new Set([base, ...keys]).size).toBe(variants.length + 1);
    });
  });

  describe('readPopularPage', () => {
    it('reads the database once, then answers from Redis', async () => {
      const load = vi.fn(async () => PAGE);
      const args = { params: routeParams(), searchParams: popularParams(), coveredBySearchCache: false, load };

      expect(await readPopularPage(args)).toEqual({ page: PAGE, source: 'db' });
      expect(await readPopularPage(args)).toEqual({ page: PAGE, source: 'redis' });

      expect(load).toHaveBeenCalledTimes(1);
      expect(setMock).toHaveBeenCalledTimes(1);
      expect(setMock.mock.calls[0]?.slice(2)).toEqual(['EX', POPULAR_PAGE_CACHE_TTL_SECONDS]);
    });

    it('stores only the page fields, not whatever else the query returned', async () => {
      const load = vi.fn(async () => ({ ...PAGE, debugPlan: 'x' }) as typeof PAGE);
      await readPopularPage({
        params: routeParams(),
        searchParams: popularParams(),
        coveredBySearchCache: false,
        load,
      });
      const stored = JSON.parse(String(setMock.mock.calls[0]?.[1])) as Record<string, unknown>;
      expect(Object.keys(stored).sort()).toEqual(['climbs', 'hasMore']);
    });
  });

  describe('climbs field resolver', () => {
    it('miss: runs the search once and caches the page for ten minutes', async () => {
      const parent = contextFor();

      expect(await climbFieldResolvers.climbs(parent)).toEqual(PAGE.climbs);
      expect(await climbFieldResolvers.hasMore(parent)).toBe(true);

      expect(searchClimbsMock).toHaveBeenCalledTimes(1);
      expect(searchClimbsMock).toHaveBeenCalledWith(parent.params, parent.searchParams, undefined);
      expect(setMock).toHaveBeenCalledTimes(1);
      expect(String(setMock.mock.calls[0]?.[0])).toContain(':popular-page:');
      expect(setMock.mock.calls[0]?.[3]).toBe(POPULAR_PAGE_CACHE_TTL_SECONDS);
    });

    it('hit: a second request for the same page never reaches the database', async () => {
      await climbFieldResolvers.climbs(contextFor());
      const second = contextFor();

      expect(await climbFieldResolvers.climbs(second)).toEqual(PAGE.climbs);
      expect(second._cachedHasMore).toBe(true);
      expect(searchClimbsMock).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent identical misses onto one database read', async () => {
      let release: (value: typeof PAGE) => void = () => {};
      searchClimbsMock.mockReturnValueOnce(
        new Promise<typeof PAGE>((resolve) => {
          release = resolve;
        }),
      );

      const pending = [contextFor(), contextFor(), contextFor()].map((parent) => climbFieldResolvers.climbs(parent));
      // Let every caller pass its Redis read and join the in-flight load.
      await new Promise((resolve) => setTimeout(resolve, 0));
      release(PAGE);

      expect(await Promise.all(pending)).toEqual([PAGE.climbs, PAGE.climbs, PAGE.climbs]);
      expect(searchClimbsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the 24 h key for a board the search cache already covers', async () => {
      await climbFieldResolvers.climbs(
        contextFor({ params: routeParams({ board_name: 'kilter' }), _isCacheable: true }),
      );

      expect(String(setMock.mock.calls[0]?.[0])).toContain(':climbs:kilter:');
      expect(setMock.mock.calls[0]?.[3]).toBe(DEFAULT_SEARCH_CACHE_TTL);
    });

    it('Redis down: still answers from the database and shares concurrent reads', async () => {
      redisState.connected = false;
      let release: (value: typeof PAGE) => void = () => {};
      searchClimbsMock.mockReturnValueOnce(
        new Promise<typeof PAGE>((resolve) => {
          release = resolve;
        }),
      );

      const pending = [contextFor(), contextFor()].map((parent) => climbFieldResolvers.climbs(parent));
      await new Promise((resolve) => setTimeout(resolve, 0));
      release(PAGE);

      expect(await Promise.all(pending)).toEqual([PAGE.climbs, PAGE.climbs]);
      expect(searchClimbsMock).toHaveBeenCalledTimes(1);
      expect(getMock).not.toHaveBeenCalled();
      expect(setMock).not.toHaveBeenCalled();
    });

    it('Redis erroring: falls through to the database instead of failing the search', async () => {
      getMock.mockRejectedValue(new Error('ECONNRESET'));
      setMock.mockRejectedValue(new Error('ECONNRESET'));

      expect(await climbFieldResolvers.climbs(contextFor())).toEqual(PAGE.climbs);
      expect(searchClimbsMock).toHaveBeenCalledTimes(1);
      expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('user-dependent search: bypasses the cache and passes the viewer through', async () => {
      const parent = contextFor({
        searchParams: popularParams({ hideCompleted: true }),
        userId: 'user-1',
        _isCacheable: false,
        _isPopularPageCacheable: false,
      });

      await climbFieldResolvers.climbs(parent);
      await climbFieldResolvers.climbs({ ...parent, _cachedClimbs: undefined, _cachedHasMore: undefined });

      expect(searchClimbsMock).toHaveBeenCalledTimes(2);
      expect(searchClimbsMock).toHaveBeenCalledWith(parent.params, parent.searchParams, 'user-1');
      expect(getMock).not.toHaveBeenCalled();
      expect(setMock).not.toHaveBeenCalled();
    });
  });
});
