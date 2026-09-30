import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { POPULAR_BOARD_CONFIGS_REFRESH_QUEUE } from '@boardsesh/db/job-queue-schema';

/**
 * `popularBoardConfigs` is the home page's resolver, and its statement was the
 * heaviest read in the app: 24 production runs in one day at a 548 s mean,
 * because every deploy DELETEd the Redis key on boot and every replica then
 * re-ran the statement (#4463 is the pool exhaustion that caused on a cold
 * window).
 *
 * These pin the shape that makes that impossible: a reader never runs the
 * statement, a miss only asks the job queue for a refresh, and the refresh
 * job writes over the old value under a cross-replica lock.
 */

const { executeMock, redisConnectedMock, redisGetMock, redisSetMock, redisEvalMock, getJobQueueMock, sendMock } =
  vi.hoisted(() => ({
    executeMock: vi.fn(),
    redisConnectedMock: vi.fn(() => false),
    redisGetMock: vi.fn(),
    redisSetMock: vi.fn(),
    redisEvalMock: vi.fn(),
    getJobQueueMock: vi.fn(),
    sendMock: vi.fn(),
  }));

vi.mock('../db/client', () => ({
  db: {
    execute: executeMock,
  },
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: redisConnectedMock,
    getClients: () => ({ publisher: { get: redisGetMock, set: redisSetMock, eval: redisEvalMock, del: vi.fn() } }),
  },
}));

vi.mock('../services/job-queue', () => ({
  getJobQueue: getJobQueueMock,
}));

import { socialBoardQueries } from '../graphql/resolvers/social/boards';
import {
  POPULAR_CONFIGS_LOCK_KEY,
  POPULAR_CONFIGS_LOCK_TTL_SECONDS,
  POPULAR_CONFIGS_REDIS_KEY,
  POPULAR_CONFIGS_REFRESH_CRON,
  refreshPopularConfigsCache,
  resetPopularConfigsForTests,
  startPopularBoardConfigsRefresh,
} from '../services/popular-board-configs';
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

const CACHED_CONFIG = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12x12 With Kickboard',
  sizeDescription: '12 x 12',
  setIds: [1, 2],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99000,
  boardCount: 12,
  displayName: 'OG 12x12',
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
  redisEvalMock.mockReset();
  redisEvalMock.mockResolvedValue(1);
  sendMock.mockReset();
  sendMock.mockResolvedValue('job-id');
  getJobQueueMock.mockReset();
  getJobQueueMock.mockReturnValue({ send: sendMock });
  resetPopularConfigsForTests();
  resetSingleFlightForTests();
});

// The resolver ignores its ctx (popularBoardConfigs is anonymous), but the
// signature demands one.
const anonCtx = { connectionId: 'conn-anon', isAuthenticated: false } as ConnectionContext;

const askForConfigs = () => socialBoardQueries.popularBoardConfigs(undefined, { input: { limit: 20 } }, anonCtx);

describe('popularBoardConfigs readers never run the statement', () => {
  it('answers from Redis without touching the database or the queue', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisGetMock.mockResolvedValue(JSON.stringify([CACHED_CONFIG]));

    const result = await askForConfigs();

    expect(result.totalCount).toBe(1);
    expect(result.configs[0]?.displayName).toBe('OG 12x12');
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('answers a Redis miss with [] and queues one refresh for a burst of callers', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisGetMock.mockResolvedValue(null);

    const results = await Promise.all([askForConfigs(), askForConfigs(), askForConfigs(), askForConfigs()]);

    for (const result of results) {
      expect(result.configs).toEqual([]);
      expect(result.totalCount).toBe(0);
    }
    // Five home-page renders on a cold key used to be five copies of a 548 s
    // statement. Now they are zero, and one job request.
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {});
  });

  it('serves the last list it saw when the key goes missing, and still asks for a refresh', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisGetMock.mockResolvedValueOnce(JSON.stringify([CACHED_CONFIG]));
    await askForConfigs();

    redisGetMock.mockResolvedValueOnce(null);
    const afterEviction = await askForConfigs();

    expect(afterEviction.configs).toHaveLength(1);
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('serves the last list it saw when Redis is unreachable, without queueing anything', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisGetMock.mockResolvedValueOnce(JSON.stringify([CACHED_CONFIG]));
    await askForConfigs();

    redisGetMock.mockRejectedValueOnce(new Error('redis down mid-flight'));
    const duringOutage = await askForConfigs();

    expect(duringOutage.configs).toHaveLength(1);
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('answers [] quietly on a server with no job queue', async () => {
    // Servers started by tests have no queue. The read must still answer.
    getJobQueueMock.mockReturnValue(null);

    const result = await askForConfigs();

    expect(result.configs).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('without Redis, serves the process-local copy once a refresh has filled it', async () => {
    const cold = await askForConfigs();
    expect(cold.configs).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);

    executeMock.mockResolvedValue([CONFIG_ROW]);
    await refreshPopularConfigsCache();

    const warm = await askForConfigs();
    expect(warm.totalCount).toBe(1);
    expect(warm.configs[0]?.boardType).toBe('kilter');
    // Once warm, a Redis-less server never asks again: the daily job keeps it.
    await askForConfigs();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).not.toHaveBeenCalled();
  });
});

describe('refreshPopularConfigsCache', () => {
  it('takes a cross-replica lock of at least 600 s, SETs over the old value and releases its own lock', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisSetMock.mockResolvedValue('OK');
    executeMock.mockResolvedValue([CONFIG_ROW]);

    const configs = await refreshPopularConfigsCache();

    expect(configs).toHaveLength(1);
    const [lockCall, valueCall] = redisSetMock.mock.calls;
    expect(lockCall[0]).toBe(POPULAR_CONFIGS_LOCK_KEY);
    expect(lockCall.slice(2)).toEqual(['EX', POPULAR_CONFIGS_LOCK_TTL_SECONDS, 'NX']);
    expect(POPULAR_CONFIGS_LOCK_TTL_SECONDS).toBeGreaterThanOrEqual(600);
    // A plain SET, never a DEL first: readers keep the old list until this lands.
    expect(valueCall[0]).toBe(POPULAR_CONFIGS_REDIS_KEY);
    expect(JSON.parse(valueCall[1] as string)[0].boardType).toBe('kilter');
    // Compare-and-delete with the token the lock was taken with.
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
    expect(redisEvalMock.mock.calls[0][2]).toBe(POPULAR_CONFIGS_LOCK_KEY);
    expect(redisEvalMock.mock.calls[0][3]).toBe(lockCall[1]);
  });

  it('skips the statement when another replica holds the lock', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisSetMock.mockResolvedValueOnce(null);

    await expect(refreshPopularConfigsCache()).resolves.toBeNull();

    expect(executeMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
  });

  it('runs one statement for concurrent refreshes in one process', async () => {
    const inFlight = deferredRows();
    executeMock.mockReturnValue(inFlight.promise);

    const concurrent = [refreshPopularConfigsCache(), refreshPopularConfigsCache(), refreshPopularConfigsCache()];
    await Promise.resolve();
    inFlight.resolve([CONFIG_ROW]);
    await Promise.all(concurrent);

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the old value when the statement fails, and still frees the lock', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisSetMock.mockResolvedValue('OK');
    executeMock.mockRejectedValue(new Error('canceling statement due to statement timeout'));

    await expect(refreshPopularConfigsCache()).rejects.toThrow('statement timeout');

    // Only the lock was SET; the list was never touched.
    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock.mock.calls[0][0]).toBe(POPULAR_CONFIGS_LOCK_KEY);
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
  });

  it('never writes an empty list over a good one', async () => {
    redisConnectedMock.mockReturnValue(true);
    redisSetMock.mockResolvedValue('OK');
    executeMock.mockResolvedValue([]);

    await expect(refreshPopularConfigsCache()).resolves.toBeNull();

    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock.mock.calls[0][0]).toBe(POPULAR_CONFIGS_LOCK_KEY);
  });

  it('counts climbs by required sets, not by walking every hold', async () => {
    executeMock.mockResolvedValue([CONFIG_ROW]);

    await refreshPopularConfigsCache();

    const statement = new PgDialect().sqlToQuery(executeMock.mock.calls[0][0] as SQL).sql;
    expect(statement).toContain('bc.required_set_ids <@ configs.set_ids');
    // NULL (not yet derived) counts only on MoonBoard, the one board whose list
    // page lets it through (create-climb-filters.ts).
    expect(statement).toContain("bc.required_set_ids IS NULL AND configs.board_type = 'moonboard'");
    expect(statement).not.toContain('board_climb_holds');
    // The rail's order is unchanged: most boards first, then most ascents.
    expect(statement).toContain('ORDER BY board_count DESC, total_ascents DESC');
  });
});

describe('startPopularBoardConfigsRefresh', () => {
  it('schedules the daily cron and runs the refresh as the job body', async () => {
    const scheduleMock = vi.fn().mockResolvedValue(undefined);
    let handler: (() => Promise<unknown>) | undefined;
    const workMock = vi.fn(async (_name: string, jobHandler: () => Promise<unknown>) => {
      handler = jobHandler;
      return 'worker-id';
    });
    const boss = { schedule: scheduleMock, work: workMock } as unknown as PgBoss;

    await startPopularBoardConfigsRefresh(boss);

    expect(scheduleMock).toHaveBeenCalledWith(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, POPULAR_CONFIGS_REFRESH_CRON, null, {
      tz: 'UTC',
    });
    expect(workMock.mock.calls[0][0]).toBe(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE);

    executeMock.mockResolvedValue([CONFIG_ROW]);
    await handler?.();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect((await askForConfigs()).totalCount).toBe(1);
  });
});
