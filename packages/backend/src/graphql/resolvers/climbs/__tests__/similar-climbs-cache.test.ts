import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * #4968: the similar-climbs statement is a catalogue-wide aggregate, and until
 * this module the only cache in front of it lived in the web app's
 * `unstable_cache` — instance-local storage a new build starts empty, thrown
 * away 41 times in the fourteen days Sentry measured 6,922 timed-out renders.
 *
 * Two properties, and they are not the same property:
 *   - the CACHE decides how often the statement runs;
 *   - `singleFlight` decides how many copies run at once, which per
 *     `docs/db-connectivity.md` is the one that keeps a cold window from
 *     emptying the connection pool.
 */

const { findSimilarClimbsMock, redisStore, redisState, getMock, setMock, loggerErrorMock } = vi.hoisted(() => ({
  findSimilarClimbsMock: vi.fn(),
  redisStore: new Map<string, string>(),
  redisState: { connected: true },
  getMock: vi.fn(),
  setMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('../climb-similarity', () => ({ findSimilarClimbs: findSimilarClimbsMock }));

vi.mock('../../../../utils/logger', () => ({ logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn() } }));

vi.mock('../../../../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisState.connected,
    getClients: () => ({ publisher: { get: getMock, set: setMock } }),
  },
}));

import { findSimilarClimbsCached, SIMILAR_CLIMBS_CACHE_TTL_SECONDS } from '../similar-climbs-cache';
import { resetSingleFlightForTests } from '../../../../utils/single-flight';

const ROWS = [{ uuid: 'NEIGHBOUR-1', similarity: 0.8 }];

function argsFor(overrides: Record<string, unknown> = {}) {
  return {
    boardType: 'kilter' as const,
    layoutId: 8,
    holds: [
      { holdId: 12, holdState: 'HAND' },
      { holdId: 7, holdState: 'STARTING' },
    ],
    threshold: 0.5,
    limit: 10,
    statsAngle: 40,
    ...overrides,
  } as Parameters<typeof findSimilarClimbsCached>[0];
}

describe('findSimilarClimbsCached', () => {
  beforeEach(() => {
    redisStore.clear();
    redisState.connected = true;
    findSimilarClimbsMock.mockReset();
    findSimilarClimbsMock.mockResolvedValue(ROWS);
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

  it('runs the statement once and answers the second call from Redis', async () => {
    expect(await findSimilarClimbsCached(argsFor())).toEqual(ROWS);
    expect(await findSimilarClimbsCached(argsFor())).toEqual(ROWS);

    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0]?.[2]).toBe('EX');
    expect(setMock.mock.calls[0]?.[3]).toBe(SIMILAR_CLIMBS_CACHE_TTL_SECONDS);
  });

  it('keys on the hold SET, not the row order Postgres happens to return', async () => {
    await findSimilarClimbsCached(
      argsFor({
        holds: [
          { holdId: 12, holdState: 'HAND' },
          { holdId: 7, holdState: 'STARTING' },
        ],
      }),
    );
    await findSimilarClimbsCached(
      argsFor({
        holds: [
          { holdId: 7, holdState: 'STARTING' },
          { holdId: 12, holdState: 'HAND' },
        ],
      }),
    );

    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['layoutId', { layoutId: 9 }],
    ['threshold', { threshold: 0.7 }],
    ['limit', { limit: 25 }],
    ['statsAngle', { statsAngle: 20 }],
    ['sizeId', { sizeId: 2 }],
    ['excludeUuid', { excludeUuid: 'SELF' }],
    ['holds', { holds: [{ holdId: 99, holdState: 'HAND' }] }],
  ])('does not serve one climb the answer computed for a different %s', async (_label, overrides) => {
    await findSimilarClimbsCached(argsFor());
    await findSimilarClimbsCached(argsFor(overrides));

    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent misses onto one statement', async () => {
    // Settles on a macrotask, so both callers are provably inside the helper
    // before the first statement finishes — the situation single-flight exists
    // for. An already-settled promise would let call 1 complete and clear the
    // map before call 2 ever looked, and the test would pass for the wrong
    // reason.
    findSimilarClimbsMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ROWS), 10)));

    const [first, second] = await Promise.all([findSimilarClimbsCached(argsFor()), findSimilarClimbsCached(argsFor())]);

    // The concurrency of the miss is the pool-safety property, not the hit rate.
    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(ROWS);
    expect(second).toEqual(ROWS);
  });

  it('falls through to the statement when Redis is unreachable', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    setMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await findSimilarClimbsCached(argsFor())).toEqual(ROWS);
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it('still runs, and still single-flights, with no Redis at all', async () => {
    redisState.connected = false;
    findSimilarClimbsMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ROWS), 10)));

    await Promise.all([findSimilarClimbsCached(argsFor()), findSimilarClimbsCached(argsFor())]);

    expect(findSimilarClimbsMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });
});
