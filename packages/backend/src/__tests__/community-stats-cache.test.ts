import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `communityStats` seq-scans `board_climb_events` (no created_at index, ~120 MB
 * per call) and is public. The web's five-minute cache is per instance and per
 * build, so the shared one-hour cache lives in the resolver.
 */
const { redisStore, redisState, getMock, setMock, whereMock, dbMock } = vi.hoisted(() => {
  const whereMock = vi.fn(async () => [{ climbers: 2170, lit: 136583 }]);
  const chain = { from: vi.fn(() => ({ where: whereMock })) };
  return {
    redisStore: new Map<string, string>(),
    redisState: { connected: true },
    getMock: vi.fn(),
    setMock: vi.fn(),
    whereMock,
    dbMock: { select: vi.fn(() => chain) },
  };
});

vi.mock('../db/client', () => ({ db: dbMock, dbRead: dbMock }));
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisState.connected,
    getClients: () => ({ publisher: { get: getMock, set: setMock } }),
  },
}));

import {
  communityStatsQueries,
  COMMUNITY_STATS_CACHE_KEY,
  COMMUNITY_STATS_CACHE_TTL_SECONDS,
} from '../graphql/resolvers/social/community-stats';
import { resetSingleFlightForTests } from '../utils/single-flight';

describe('communityStats cache', () => {
  beforeEach(() => {
    redisStore.clear();
    redisState.connected = true;
    dbMock.select.mockClear();
    whereMock.mockClear();
    getMock.mockReset();
    getMock.mockImplementation(async (key: string) => redisStore.get(key) ?? null);
    setMock.mockReset();
    setMock.mockImplementation(async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    });
    resetSingleFlightForTests();
  });

  it('scans once on a miss and serves the next call from Redis for an hour', async () => {
    const first = await communityStatsQueries.communityStats();
    const second = await communityStatsQueries.communityStats();

    expect(first).toMatchObject({ climbersLast30Days: 2170, litLast30Days: 136583 });
    // The hit keeps the original computedAt, so the page can say how old it is.
    expect(second).toEqual(first);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      COMMUNITY_STATS_CACHE_KEY,
      expect.any(String),
      'EX',
      COMMUNITY_STATS_CACHE_TTL_SECONDS,
    );
    expect(COMMUNITY_STATS_CACHE_TTL_SECONDS).toBe(3600);
  });

  it('falls through to the scan when Redis is down', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    setMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await communityStatsQueries.communityStats()).toMatchObject({ climbersLast30Days: 2170 });
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('scans every call when Redis is not configured', async () => {
    redisState.connected = false;

    await communityStatsQueries.communityStats();
    await communityStatsQueries.communityStats();

    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });
});
