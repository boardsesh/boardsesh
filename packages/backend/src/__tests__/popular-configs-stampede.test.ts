import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * #4463: `popularBoardConfigs` is the home page's resolver and the heaviest
 * read in the app — 82 s on the dev database when cold. It is Redis-cached,
 * but the fall-through had no concurrency control, so N simultaneous visitors
 * during a cold window meant N simultaneous copies, each pinning one of the
 * pool's ten connections. Once the pool was gone every other query in the
 * process queued behind it forever (postgres.js's acquire queue is unbounded
 * and untimed), which is what made `/embed/**` renders hang for 60 s+ in the
 * e2e suite — the CI backend runs with no REDIS_URL, so every render was a
 * cold window.
 *
 * These pin the two properties that make that impossible: one in-flight
 * statement per process, and a process-local copy when there is no Redis to
 * hold one.
 */

const { executeMock, redisConnectedMock, redisGetMock, redisSetMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  redisConnectedMock: vi.fn(() => false),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
}));

vi.mock('../db/client', () => ({
  db: {
    execute: executeMock,
  },
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: redisConnectedMock,
    getClients: () => ({ publisher: { get: redisGetMock, set: redisSetMock, del: vi.fn() } }),
  },
}));

import {
  socialBoardQueries,
  dropPopularConfigsFallback,
  warmPopularConfigsCache,
} from '../graphql/resolvers/social/boards';
import { resetSingleFlightForTests } from '../utils/single-flight';

const CONFIG_ROW = {
  board_type: 'kilter',
  layout_id: 1,
  layout_name: 'Kilter Board Original',
  size_id: 10,
  size_name: '12x12 With Kickboard',
  size_description: '12 x 12',
  set_ids: [1, 2],
  set_names: ['Bolt Ons', 'Screw Ons'],
  climb_count: 4200,
  total_ascents: 99000,
  board_count: 12,
};

function deferredRows() {
  let resolve!: (rows: unknown) => void;
  const promise = new Promise<unknown>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

beforeEach(() => {
  executeMock.mockReset();
  redisConnectedMock.mockReset();
  redisConnectedMock.mockReturnValue(false);
  redisGetMock.mockReset();
  redisSetMock.mockReset();
  dropPopularConfigsFallback();
  resetSingleFlightForTests();
});

// The resolver ignores its ctx (popularBoardConfigs is anonymous), but the
// signature demands one.
const anonCtx = { connectionId: 'conn-anon', isAuthenticated: false } as ConnectionContext;

const askForConfigs = () => socialBoardQueries.popularBoardConfigs(undefined, { input: { limit: 20 } }, anonCtx);

describe('popularBoardConfigs does not stampede the connection pool', () => {
  it('runs one statement for callers that arrive while the first is still running', async () => {
    const inFlight = deferredRows();
    executeMock.mockReturnValue(inFlight.promise);

    const concurrent = [askForConfigs(), askForConfigs(), askForConfigs(), askForConfigs(), askForConfigs()];
    // Five concurrent home-page renders, one pool connection.
    expect(executeMock).toHaveBeenCalledTimes(1);

    inFlight.resolve([CONFIG_ROW]);
    const results = await Promise.all(concurrent);

    expect(executeMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.totalCount).toBe(1);
      expect(result.configs[0]?.boardType).toBe('kilter');
    }
  });

  it('answers a later caller from the process-local copy when there is no Redis', async () => {
    executeMock.mockResolvedValue([CONFIG_ROW]);

    await askForConfigs();
    await askForConfigs();

    // Without the fallback, single-flight alone would re-run the 82 s
    // statement for the first caller after every completion.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('re-runs the statement on the deploy warm-up instead of answering it from the last run', async () => {
    executeMock.mockResolvedValue([CONFIG_ROW]);

    await askForConfigs();
    expect(executeMock).toHaveBeenCalledTimes(1);

    // `warmPopularConfigsCache` exists to re-run the query on every deploy
    // because the Aurora sync may have moved the data under it. With Redis it
    // does that by DELETing the cache key; with no Redis it must drop the
    // process-local copy, or the warm-up is answered from the previous run's
    // fixture and quietly does nothing.
    await warmPopularConfigsCache();
    expect(executeMock).toHaveBeenCalledTimes(2);

    // The warm-up re-seeded the copy, so the next visitor is still cheap.
    await askForConfigs();
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the Redis path exactly as it was — no process-local copy is consulted', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisGetMock.mockResolvedValue(null);
    executeMock.mockResolvedValue([CONFIG_ROW]);

    await askForConfigs();
    await askForConfigs();

    // Every call still asks Redis first and still writes back, so the
    // deliberate cache DELETE `warmPopularConfigsCache` does on each deploy
    // is still what decides freshness in production.
    expect(redisGetMock).toHaveBeenCalledTimes(2);
    expect(redisSetMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});
