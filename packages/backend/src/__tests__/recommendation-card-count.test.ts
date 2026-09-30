import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  buildRecommendationCountSql,
  buildRecommendationRefsSql,
  buildRecommendationSentOverlapSql,
  recommendationStatsConditions,
  type BoardTarget,
  type RecommendationQueryParams,
  type RecommendationType,
  type SerialPlanDb,
} from '@boardsesh/db/queries';

/**
 * The Discover cards' recommendation counts (C6). The catalog half is the same
 * for everyone on a board config and is cached; the viewer's sends are counted
 * live and subtracted. Catalog minus sent equals the NOT EXISTS count exactly
 * (16 of 16 config x type cases on the replica), so only the staleness of the
 * catalog half changes.
 */
const { state, fakeTx, redisStore, redisState, getMock, setMock } = vi.hoisted(() => {
  const state = {
    render: (_statement: unknown): string => '',
    executed: [] as string[],
    rowsFor: (_renderedSql: string): unknown[] => [],
  };
  const fakeTx = {
    execute: (statement: unknown) => {
      const rendered = state.render(statement);
      state.executed.push(rendered);
      return Promise.resolve(state.rowsFor(rendered));
    },
  };
  return {
    state,
    fakeTx,
    redisStore: new Map<string, string>(),
    redisState: { connected: true },
    getMock: vi.fn(),
    setMock: vi.fn(),
  };
});

vi.mock('../db/client', () => ({ db: fakeTx, dbRead: fakeTx }));
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisState.connected,
    getClients: () => ({ publisher: { get: getMock, set: setMock } }),
  },
}));

import {
  countRecommendationCardClimbs,
  recommendationCountCacheKey,
  RECOMMENDATION_COUNT_CACHE_TTL_SECONDS,
} from '../graphql/resolvers/playlists/helpers/recommendation-refs';
import { resetSingleFlightForTests } from '../utils/single-flight';

const dialect = new PgDialect();
state.render = (statement: unknown) => dialect.sqlToQuery(statement as SQL).sql;
const render = (statement: SQL) => dialect.sqlToQuery(statement).sql;

const TARGET: BoardTarget = { boardType: 'kilter', layoutId: 1, sizeId: 10, angle: 40, setIds: [20, 1] };
const tx = fakeTx as unknown as SerialPlanDb;

const isOverlap = (renderedSql: string) => /\) sent/.test(renderedSql);
const isGradeBand = (renderedSql: string) => /max_difficulty/.test(renderedSql);

function paramsFor(type: RecommendationType, overrides: Partial<RecommendationQueryParams> = {}) {
  return {
    type,
    target: TARGET,
    shorterSizeIds: [],
    narrowerSameHeightSizeIds: [],
    gradeBand: type === 'RECOMMENDED_AT_LEVEL' ? { minDifficultyId: 18, maxDifficultyId: 22 } : null,
    excludeUserId: 'user-1',
    freshWindowDays: 365,
    ...overrides,
  } satisfies RecommendationQueryParams;
}

beforeEach(() => {
  state.executed.length = 0;
  state.rowsFor = (renderedSql) => (isOverlap(renderedSql) ? [{ count: 13 }] : [{ count: 284 }]);
  redisStore.clear();
  redisState.connected = true;
  getMock.mockReset();
  getMock.mockImplementation(async (key: string) => redisStore.get(key) ?? null);
  setMock.mockReset();
  setMock.mockImplementation(async (key: string, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  });
  resetSingleFlightForTests();
});

describe('countRecommendationCardClimbs', () => {
  it('on a miss counts the catalog without the viewer, caches it, and subtracts their sends', async () => {
    const count = await countRecommendationCardClimbs('RECOMMENDED_CROWD_FAVORITES', TARGET, 'user-1', tx);

    expect(count).toBe(284 - 13);
    const [catalog, overlap] = state.executed;
    expect(catalog).not.toContain('boardsesh_ticks');
    expect(overlap).toContain('boardsesh_ticks');
    expect(setMock).toHaveBeenCalledWith(
      'rec-count:v1:RECOMMENDED_CROWD_FAVORITES:kilter:1:10:1,20:40',
      '284',
      'EX',
      RECOMMENDATION_COUNT_CACHE_TTL_SECONDS,
    );
    expect(RECOMMENDATION_COUNT_CACHE_TTL_SECONDS).toBe(6 * 60 * 60);
  });

  it('on a hit runs only the viewer overlap', async () => {
    redisStore.set('rec-count:v1:RECOMMENDED_CROWD_FAVORITES:kilter:1:10:1,20:40', '300');

    const count = await countRecommendationCardClimbs('RECOMMENDED_CROWD_FAVORITES', TARGET, 'user-1', tx);

    expect(count).toBe(300 - 13);
    expect(state.executed).toHaveLength(1);
    expect(isOverlap(state.executed[0])).toBe(true);
  });

  it('falls through to both queries when Redis is down', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    setMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await countRecommendationCardClimbs('RECOMMENDED_HIDDEN_GEMS', TARGET, 'user-1', tx)).toBe(271);
    expect(state.executed).toHaveLength(2);
  });

  it('skips the overlap when the catalog is empty, and never goes below zero', async () => {
    state.rowsFor = (renderedSql) => (isOverlap(renderedSql) ? [{ count: 5 }] : [{ count: 0 }]);
    expect(await countRecommendationCardClimbs('RECOMMENDED_FRESH', TARGET, 'user-1', tx)).toBe(0);
    expect(state.executed).toHaveLength(1);

    // A stale catalog half that is smaller than the live overlap clamps to 0.
    redisStore.set('rec-count:v1:RECOMMENDED_CROWD_FAVORITES:kilter:1:10:1,20:40', '3');
    expect(await countRecommendationCardClimbs('RECOMMENDED_CROWD_FAVORITES', TARGET, 'user-1', tx)).toBe(0);
  });

  it('keys AT_LEVEL on the resolved grade band', async () => {
    state.rowsFor = (renderedSql) => {
      if (isGradeBand(renderedSql)) return [{ board_type: 'kilter', max_difficulty: 20 }];
      return isOverlap(renderedSql) ? [{ count: 1 }] : [{ count: 50 }];
    };

    await countRecommendationCardClimbs('RECOMMENDED_AT_LEVEL', TARGET, 'user-1', tx);

    expect(setMock.mock.calls[0][0]).toMatch(/^rec-count:v1:RECOMMENDED_AT_LEVEL:kilter:1:10:1,20:40:\d+-\d+$/);
  });
});

describe('recommendationCountCacheKey', () => {
  it('sorts sets and folds the two no-set shapes together', () => {
    expect(recommendationCountCacheKey(paramsFor('RECOMMENDED_FRESH'))).toBe(
      'rec-count:v1:RECOMMENDED_FRESH:kilter:1:10:1,20:40',
    );
    const noSets = (setIds: number[] | null) =>
      recommendationCountCacheKey(paramsFor('RECOMMENDED_FRESH', { target: { ...TARGET, setIds } }));
    expect(noSets(null)).toBe(noSets([]));
    expect(noSets(null)).toBe('rec-count:v1:RECOMMENDED_FRESH:kilter:1:10:all:40');
  });

  it('does not depend on the viewer', () => {
    expect(recommendationCountCacheKey(paramsFor('RECOMMENDED_CROWD_FAVORITES', { excludeUserId: 'a' }))).toBe(
      recommendationCountCacheKey(paramsFor('RECOMMENDED_CROWD_FAVORITES', { excludeUserId: 'b' })),
    );
  });
});

describe('recommendation count SQL', () => {
  it.each(['RECOMMENDED_CROWD_FAVORITES', 'RECOMMENDED_AT_LEVEL'] as const)(
    '%s is driven from a MATERIALIZED stats CTE with sargable bounds',
    (type) => {
      const rendered = render(buildRecommendationCountSql(paramsFor(type)));
      expect(rendered).toContain('WITH cand AS MATERIALIZED');
      expect(rendered).toContain('s.quality_average >=');
      expect(rendered).not.toContain('COALESCE(s.quality_average, 0) >=');
      expect(rendered).toContain('NOT EXISTS');
    },
  );

  it.each(['RECOMMENDED_HIDDEN_GEMS', 'RECOMMENDED_FRESH'] as const)('%s keeps the catalog-driven plan', (type) => {
    const rendered = render(buildRecommendationCountSql(paramsFor(type)));
    expect(rendered).not.toContain('MATERIALIZED');
    expect(rendered).toMatch(/FROM board_climbs bc/);
  });

  it('drops the viewer exclusion for the cached catalog half', () => {
    const rendered = render(
      buildRecommendationCountSql(paramsFor('RECOMMENDED_CROWD_FAVORITES', { excludeUserId: null })),
    );
    expect(rendered).not.toContain('boardsesh_ticks');
  });

  it('drives the overlap from the viewer ticks and skips the stats join for FRESH', () => {
    const fresh = render(buildRecommendationSentOverlapSql(paramsFor('RECOMMENDED_FRESH'), 'user-1'));
    expect(fresh).toMatch(/SELECT DISTINCT t\.climb_uuid FROM boardsesh_ticks t/);
    expect(fresh).not.toContain('board_climb_stats');
    const crowd = render(buildRecommendationSentOverlapSql(paramsFor('RECOMMENDED_CROWD_FAVORITES'), 'user-1'));
    expect(crowd).toContain('JOIN board_climb_stats s');
    expect(crowd).not.toContain('LEFT JOIN board_climb_stats');
  });

  it('leaves the ranked page query unchanged in shape', () => {
    const rendered = render(buildRecommendationRefsSql(paramsFor('RECOMMENDED_CROWD_FAVORITES'), 0, 20));
    expect(rendered).toContain('COALESCE(s.quality_average, 0) >=');
    expect(rendered).toContain('LEFT JOIN board_setter_stats ss');
    expect(rendered).not.toContain('MATERIALIZED');
  });

  it('refuses sargable bounds that would change the count', () => {
    expect(() => recommendationStatsConditions({ minQuality: 0, minAscents: 20 }, true)).toThrow();
    expect(() => recommendationStatsConditions({ minQuality: 4, minAscents: 0 }, true)).toThrow();
    expect(() => recommendationStatsConditions({ minQuality: 0, minAscents: 0 }, false)).not.toThrow();
  });
});
