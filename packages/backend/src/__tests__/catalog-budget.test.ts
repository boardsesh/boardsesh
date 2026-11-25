import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  CATALOG_BUDGET_LIMITS,
  CatalogRateLimitError,
  createCatalogBudgetLimiter,
  type CatalogAccessLease,
  type CatalogBudgetRedis,
  type CatalogBudgetRequest,
} from '../utils/catalog-budget';

vi.mock('../redis/client', () => ({
  redisClientManager: { isRedisConnected: () => false },
}));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const START = Date.parse('2026-11-25T12:00:00Z');
const guest = { trustedClientIp: '198.51.100.10' };
const user = { userId: 'climber-1', trustedClientIp: '198.51.100.10' };
const request: CatalogBudgetRequest = { operation: 'searchClimbs', lane: 'interactive', requestedRows: 500 };

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function localLimiter() {
  let timestamp = START;
  const limiter = createCatalogBudgetLimiter({ now: () => timestamp, redis: () => null });
  return {
    ...limiter,
    advance: (milliseconds: number) => {
      timestamp += milliseconds;
    },
  };
}

function allowed(counts: number[]): string {
  return JSON.stringify({ allowed: true, counts });
}

type RedisEval = CatalogBudgetRedis['eval'];

afterEach(() => vi.useRealTimers());

describe('catalog budget local fallback', () => {
  it.each(['2024-01-01T12:00:00Z', '2026-11-25T12:00:00Z', '2026-12-02T12:00:00Z'])(
    'enforces immediately, independent of the calendar date (%s)',
    async (date) => {
      const limiter = createCatalogBudgetLimiter({ now: () => Date.parse(date), redis: () => null });
      await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1_000_000 })).rejects.toMatchObject(
        {
          code: 'RATE_LIMITED',
          reason: 'rows',
          snapshotManifestUrl: expect.stringContaining('/manifest.json'),
        },
      );
    },
  );

  it('shares weighted work across operations and changing authenticated IPs', async () => {
    const limiter = localLimiter();
    const lease = await limiter.reserveCatalogAccess(user, { ...request, workUnits: 180 });
    await limiter.releaseCatalogAccess(lease, 0);
    await expect(
      limiter.reserveCatalogAccess(
        { ...user, trustedClientIp: '198.51.100.99' },
        { ...request, operation: 'climbDetails' },
      ),
    ).rejects.toMatchObject({ reason: 'work', retryAfterSeconds: 60 });
    limiter.advance(60_000);
    await expect(limiter.reserveCatalogAccess(user, request)).resolves.toMatchObject({ mode: 'local' });
  });

  it('bounds anonymous rows while authenticated climbers retain more headroom', async () => {
    const limiter = localLimiter();
    await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000 });
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
      retryAfterSeconds: 3600,
    });
    await expect(limiter.reserveCatalogAccess(user, { ...request, requestedRows: 100_000 })).resolves.toBeDefined();
  });

  it('gives only an explicit server-cache identity its separate bounded allowance', async () => {
    const limiter = localLimiter();
    const service = { service: 'www-catalog-cache' } as const;
    const lease = await limiter.reserveCatalogAccess(service, { ...request, workUnits: 600, requestedRows: 500_000 });
    await limiter.releaseCatalogAccess(lease);
    await expect(limiter.reserveCatalogAccess(service, request)).rejects.toMatchObject({ reason: 'work' });
    await expect(
      limiter.reserveCatalogAccess({ userId: 'service:www-catalog-cache' }, { ...request, workUnits: 600 }),
    ).rejects.toMatchObject({ reason: 'work' });
    await expect(
      limiter.reserveCatalogAccess({ ...service, ...user }, { ...request, workUnits: 600 }),
    ).rejects.toMatchObject({ reason: 'work' });
  });

  it('keeps cache service work outside visitor and authenticated IP buckets', async () => {
    const limiter = localLimiter();
    const visitor = await limiter.reserveCatalogAccess(guest, { ...request, workUnits: 180 });
    await limiter.releaseCatalogAccess(visitor);
    for (let index = 0; index < 20; index++) {
      const lease = await limiter.reserveCatalogAccess(
        { ...user, userId: `ip-user-${index}` },
        { ...request, workUnits: 180 },
      );
      await limiter.releaseCatalogAccess(lease);
    }
    await expect(
      limiter.reserveCatalogAccess({ service: 'www-catalog-cache', trustedClientIp: guest.trustedClientIp }, request),
    ).resolves.toBeDefined();
  });

  it('shares the day budget across hourly windows, then resets on the next UTC day', async () => {
    const limiter = localLimiter();
    for (const requestedRows of [30_000, 30_000, 30_000, 10_000]) {
      const lease = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows });
      await limiter.releaseCatalogAccess(lease);
      limiter.advance(3_600_000);
    }
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
      retryAfterSeconds: 8 * 3600,
    });
    limiter.advance(8 * 3_600_000);
    await expect(limiter.reserveCatalogAccess(guest, request)).resolves.toBeDefined();
  });

  it('refunds unused rows once, including concurrent releases, without refunding work', async () => {
    const limiter = localLimiter();
    const first = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000, workUnits: 90 });
    await Promise.all([limiter.releaseCatalogAccess(first, 0), limiter.releaseCatalogAccess(first, 0)]);
    const second = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000, workUnits: 90 });
    await limiter.releaseCatalogAccess(first, 0);
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })).rejects.toMatchObject({
      reason: 'work',
    });
    limiter.advance(60_000);
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
    await limiter.releaseCatalogAccess(second, 30_000);
  });

  it('uses its stored reservation rather than a mutated lease amount', async () => {
    const limiter = localLimiter();
    const first = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 10 });
    first.requestedRows = 30_000;
    const second = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 29_990 });
    await limiter.releaseCatalogAccess(first, 0);
    await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 10 });
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
    await limiter.releaseCatalogAccess(second);
  });

  it('does not refund when a caller returns more rows than its reserved upper bound', async () => {
    const limiter = localLimiter();
    const lease = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000 });
    await limiter.releaseCatalogAccess(lease, 50_000);
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
  });

  it('admits only six overlapping interactive queries for one identity', async () => {
    const limiter = localLimiter();
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () => limiter.reserveCatalogAccess(user, request)),
    );
    const accepted = results.filter((result) => result.status === 'fulfilled');
    expect(accepted).toHaveLength(6);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await limiter.releaseCatalogAccess(accepted[0].value, 0);
    await expect(limiter.reserveCatalogAccess(user, request)).resolves.toBeDefined();
  });

  it('bounds process-wide outage concurrency across unrelated identities', async () => {
    const limiter = localLimiter();
    const leases = await Promise.all(
      Array.from({ length: CATALOG_BUDGET_LIMITS.fallbackConcurrency }, (_, index) =>
        limiter.reserveCatalogAccess({ userId: `climber-${index}` }, request),
      ),
    );
    await expect(limiter.reserveCatalogAccess({ userId: 'another-climber' }, request)).rejects.toMatchObject({
      reason: 'concurrency',
    });
    await limiter.releaseCatalogAccess(leases[0], 0);
    await expect(limiter.reserveCatalogAccess({ userId: 'another-climber' }, request)).resolves.toBeDefined();
  });

  it('allows a gym NAT to serve multiple independent authenticated row budgets', async () => {
    const limiter = localLimiter();
    for (let index = 0; index < 20; index++) {
      const lease = await limiter.reserveCatalogAccess(
        { ...user, userId: `climber-${index}` },
        { ...request, requestedRows: 100_000 },
      );
      await limiter.releaseCatalogAccess(lease);
    }
    await expect(
      limiter.reserveCatalogAccess({ ...user, userId: 'climber-21' }, { ...request, requestedRows: 1 }),
    ).rejects.toMatchObject({ reason: 'rows' });
  });

  it('keeps sync recovery separate and refunds empty 500-row polls', async () => {
    const limiter = localLimiter();
    const interactive = await limiter.reserveCatalogAccess(user, { ...request, requestedRows: 100_000 });
    await limiter.releaseCatalogAccess(interactive);
    const syncRequest: CatalogBudgetRequest = { ...request, lane: 'sync', requestedRows: 5_000_000 - 500 };
    const coldStart = await limiter.reserveCatalogAccess(user, syncRequest);
    await limiter.releaseCatalogAccess(coldStart);
    for (let index = 0; index < 10; index++) {
      await expect(limiter.runCatalogQuery(user, { ...request, lane: 'sync' }, async () => [])).resolves.toEqual([]);
    }
    await expect(limiter.reserveCatalogAccess(user, { ...request, lane: 'sync' })).resolves.toBeDefined();
    await expect(
      limiter.reserveCatalogAccess(user, { ...request, lane: 'sync', requestedRows: 1 }),
    ).rejects.toMatchObject({ reason: 'rows' });
  });

  it('releases failed queries and their row reservations while charging attempted work', async () => {
    const limiter = localLimiter();
    const queryError = new Error('database query failed');
    await expect(
      limiter.runCatalogQuery(guest, { ...request, requestedRows: 30_000, workUnits: 180 }, async () => {
        throw queryError;
      }),
    ).rejects.toBe(queryError);
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'work' });
    limiter.advance(60_000);
    await expect(
      limiter.runCatalogQuery(
        guest,
        { ...request, requestedRows: 30_000 },
        async () => ({ climbs: [] }),
        (result) => result.climbs.length,
      ),
    ).resolves.toEqual({ climbs: [] });
  });

  it('does not refund stale leases or let them release newer work', async () => {
    const limiter = localLimiter();
    const stale = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000 });
    limiter.advance(CATALOG_BUDGET_LIMITS.leaseTtlMs + 1);
    const current = await Promise.all(
      Array.from({ length: 6 }, () => limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })),
    );
    await limiter.releaseCatalogAccess(stale, 0);
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })).rejects.toMatchObject({
      reason: 'concurrency',
    });
    await limiter.releaseCatalogAccess(current[0]);
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
  });

  it('bounds memory without evicting active budgets to admit a fresh identity', async () => {
    const limiter = localLimiter();
    const identityCount = Math.floor(CATALOG_BUDGET_LIMITS.maxLocalBuckets / 3);
    for (let index = 0; index < identityCount; index++) {
      const lease = await limiter.reserveCatalogAccess(
        { trustedClientIp: `test-address-${index}` },
        { ...request, requestedRows: 0 },
      );
      await limiter.releaseCatalogAccess(lease);
    }
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'capacity' });
    limiter.advance(24 * 3_600_000);
    await expect(limiter.reserveCatalogAccess(guest, request)).resolves.toBeDefined();
  });

  it.each([-1, NaN, Infinity, 0.5])('rejects invalid requested row amount %s', async (requestedRows) => {
    await expect(localLimiter().reserveCatalogAccess(guest, { ...request, requestedRows })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('catalog budget Redis failure boundaries', () => {
  it('keeps active outage leases within the identity concurrency ceiling after recovery', async () => {
    let online = false;
    const evaluate = vi.fn<RedisEval>().mockResolvedValue(1);
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => (online ? { eval: evaluate } : null) });
    const leases = await Promise.all(Array.from({ length: 6 }, () => limiter.reserveCatalogAccess(guest, request)));
    online = true;
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'concurrency' });
    expect(evaluate).not.toHaveBeenCalled();
    await limiter.releaseCatalogAccess(leases[0], 0);
    evaluate.mockResolvedValue(allowed([7, 3000, 3000]));
    await expect(limiter.reserveCatalogAccess(guest, request)).resolves.toMatchObject({ mode: 'redis' });
  });

  it('includes pending Redis admissions when local fallback checks concurrency', async () => {
    const reply = deferred<unknown>();
    let online = true;
    const limiter = createCatalogBudgetLimiter({
      now: () => START,
      redis: () => (online ? { eval: () => reply.promise } : null),
    });
    const pending = limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 });
    online = false;
    await Promise.all(
      Array.from({ length: 5 }, () => limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })),
    );
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })).rejects.toMatchObject({
      reason: 'concurrency',
    });
    reply.resolve(allowed([1, 0, 0]));
    await pending;
  });

  it('does not reduce its fallback budget when Redis admission replies arrive out of order', async () => {
    const firstReply = deferred<unknown>();
    const secondReply = deferred<unknown>();
    const evaluate = vi
      .fn<RedisEval>()
      .mockReturnValueOnce(firstReply.promise)
      .mockReturnValueOnce(secondReply.promise);
    let online = true;
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => (online ? { eval: evaluate } : null) });
    const first = limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0, workUnits: 90 });
    const second = limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0, workUnits: 90 });
    secondReply.resolve(allowed([180, 0, 0]));
    await second;
    firstReply.resolve(allowed([90, 0, 0]));
    await first;
    online = false;
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })).rejects.toMatchObject({
      reason: 'work',
    });
  });

  it('does not double-refund a newer observation when a release reply is delayed', async () => {
    const releaseReply = deferred<unknown>();
    const evaluate = vi
      .fn<RedisEval>()
      .mockResolvedValueOnce(allowed([1, 15_000, 15_000]))
      .mockReturnValueOnce(releaseReply.promise)
      .mockResolvedValueOnce(allowed([2, 500, 500]));
    let online = true;
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => (online ? { eval: evaluate } : null) });
    const first = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 15_000 });
    const releasing = limiter.releaseCatalogAccess(first, 0);
    // Redis has applied the refund, but that release reply is still in transit.
    await limiter.reserveCatalogAccess(guest, request);
    releaseReply.resolve(1);
    await releasing;
    online = false;
    await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 29_500 });
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
  });

  it('refreshes a healthy shadow after a different instance refunds rows', async () => {
    const evaluate = vi
      .fn<RedisEval>()
      .mockResolvedValueOnce(allowed([1, 15_000, 15_000]))
      .mockResolvedValueOnce(allowed([2, 500, 500]));
    let online = true;
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => (online ? { eval: evaluate } : null) });
    await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 15_000 });
    // The other backend settled the first lease; the next observation includes its refund.
    await limiter.reserveCatalogAccess(guest, request);
    online = false;
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 29_500 })).resolves.toMatchObject({
      mode: 'local',
    });
  });

  it('falls back if Redis disconnects while acquiring its client', async () => {
    const limiter = createCatalogBudgetLimiter({
      now: () => START,
      redis: () => {
        throw new Error('Redis is disconnected');
      },
    });
    await expect(limiter.reserveCatalogAccess(guest, request)).resolves.toMatchObject({ mode: 'local' });
  });

  it('does not reset a budget when Redis fails and recovers', async () => {
    const evaluate = vi.fn<RedisEval>().mockResolvedValue(allowed([179, 0, 0]));
    let online = true;
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => (online ? { eval: evaluate } : null) });
    const first = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0, workUnits: 179 });
    evaluate.mockResolvedValue(1);
    await limiter.releaseCatalogAccess(first);
    online = false;
    const fallback = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 });
    await limiter.releaseCatalogAccess(fallback);
    online = true;
    evaluate.mockImplementation(async (_script, keyCount, ...arguments_) => {
      const payload = JSON.parse(String(arguments_[keyCount])) as { counters: { floor: number }[] };
      expect(payload.counters[0].floor).toBe(180);
      return JSON.stringify({ allowed: false, reason: 'work', retryAfterSeconds: 60, counts: [180, 0, 0] });
    });
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'work' });
    online = false;
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'work' });
  });

  it('retains outage charges that overlap an earlier Redis response', async () => {
    const response = deferred<unknown>();
    let online = true;
    const limiter = createCatalogBudgetLimiter({
      now: () => START,
      redis: () => (online ? { eval: () => response.promise } : null),
    });
    const inFlight = limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 });
    online = false;
    const local = await limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0, workUnits: 179 });
    await limiter.releaseCatalogAccess(local);
    response.resolve(allowed([1, 0, 0]));
    await inFlight;
    await expect(limiter.reserveCatalogAccess(guest, { ...request, requestedRows: 0 })).rejects.toMatchObject({
      reason: 'work',
    });
  });

  it('does not turn a distributed refusal into a local admission', async () => {
    const evaluate = vi
      .fn<RedisEval>()
      .mockResolvedValue(
        JSON.stringify({ allowed: false, reason: 'concurrency', retryAfterSeconds: 12, counts: [0, 0, 0] }),
      );
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => ({ eval: evaluate }) });
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({
      reason: 'concurrency',
      retryAfterSeconds: 12,
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('uses the bounded local budget when Redis returns malformed data', async () => {
    const limiter = createCatalogBudgetLimiter({
      now: () => START,
      redis: () => ({ eval: async () => 'not json' }),
    });
    await expect(limiter.reserveCatalogAccess(guest, request)).resolves.toMatchObject({ mode: 'local' });
  });

  it('ends Redis waits at 100ms and releases a timed-out reservation using the same id', async () => {
    vi.useFakeTimers();
    const response = deferred<unknown>();
    const evaluate = vi.fn<RedisEval>().mockReturnValueOnce(response.promise).mockResolvedValue(1);
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => ({ eval: evaluate }) });
    const reserving = limiter.reserveCatalogAccess(guest, request);
    await vi.advanceTimersByTimeAsync(101);
    const lease = await reserving;
    expect(lease.mode).toBe('local');
    await limiter.releaseCatalogAccess(lease, 0);
    const reservationKey = evaluate.mock.calls[0][2];
    expect(evaluate.mock.calls[1][2]).toBe(reservationKey);
    response.resolve(allowed([1, 500, 500]));
  });

  it('does not mask query results when Redis release fails', async () => {
    const evaluate = vi
      .fn<RedisEval>()
      .mockResolvedValueOnce(allowed([1, 500, 500]))
      .mockRejectedValue(new Error('down'));
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => ({ eval: evaluate }) });
    await expect(limiter.runCatalogQuery(guest, request, async () => ['climb'])).resolves.toEqual(['climb']);
  });
});

/** Opt in with an isolated Redis URL; every key is additionally namespaced per suite. */
describe.skipIf(!process.env.CATALOG_BUDGET_TEST_REDIS_URL)('catalog budget real Redis atomicity', () => {
  let client: Redis;
  let adapter: CatalogBudgetRedis;
  const touchedKeys = new Set<string>();
  const namespace = `catalog-budget-test:${randomUUID()}:`;
  let timestamp = START;

  beforeAll(async () => {
    client = new Redis(process.env.CATALOG_BUDGET_TEST_REDIS_URL!, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    await client.connect();
    adapter = {
      eval: (script, keyCount, ...arguments_) => {
        const keys = arguments_.slice(0, keyCount).map((key) => `${namespace}${key}`);
        keys.forEach((key) => touchedKeys.add(key));
        return client.eval(script, keyCount, ...keys, ...arguments_.slice(keyCount));
      },
    };
  });

  afterEach(async () => {
    if (touchedKeys.size) await client.del(...touchedKeys);
    touchedKeys.clear();
    timestamp = START;
  });

  afterAll(async () => {
    if (client?.status === 'ready') await client.quit();
    else client?.disconnect();
  });

  function backend() {
    return createCatalogBudgetLimiter({ now: () => timestamp, redis: () => adapter });
  }

  it('atomically shares work budgets across separate backend instances', async () => {
    const instances = Array.from({ length: 4 }, backend);
    const outcomes = await Promise.allSettled(
      instances.map((instance) => instance.reserveCatalogAccess(guest, { ...request, workUnits: 60 })),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3);
    const denied = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(denied?.reason).toBeInstanceOf(CatalogRateLimitError);
    expect(denied?.reason).toMatchObject({ reason: 'work' });
  });

  it('releases on a different instance and refunds exactly once', async () => {
    const first = backend();
    const second = backend();
    const lease = await first.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000 });
    await Promise.all([second.releaseCatalogAccess(lease, 0), first.releaseCatalogAccess(lease, 0)]);
    await second.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000 });
    await first.releaseCatalogAccess(lease, 0);
    await expect(second.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
  });

  it('caps global concurrency across instances and identities, then releases one slot', async () => {
    const leases: CatalogAccessLease[] = [];
    const first = backend();
    for (let index = 0; index < CATALOG_BUDGET_LIMITS.globalConcurrency; index++) {
      leases.push(await backend().reserveCatalogAccess({ userId: `parallel-user-${index}` }, request));
    }
    await expect(first.reserveCatalogAccess({ userId: 'one-too-many' }, request)).rejects.toMatchObject({
      reason: 'concurrency',
    });
    await first.releaseCatalogAccess(leases[0], 0);
    await expect(first.reserveCatalogAccess({ userId: 'one-too-many' }, request)).resolves.toBeDefined();
  });

  it('ignores stale and nonexistent releases without refunding live rows', async () => {
    const first = backend();
    const second = backend();
    const lease = await first.reserveCatalogAccess(guest, { ...request, requestedRows: 30_000 });
    await second.releaseCatalogAccess({ ...lease, id: randomUUID() }, 0);
    timestamp += CATALOG_BUDGET_LIMITS.leaseTtlMs + 1;
    await second.releaseCatalogAccess(lease, 0);
    await expect(second.reserveCatalogAccess(guest, { ...request, requestedRows: 1 })).rejects.toMatchObject({
      reason: 'rows',
    });
  });

  it('carries local outage work into Redis before admitting recovery traffic', async () => {
    let online = false;
    const first = createCatalogBudgetLimiter({ now: () => timestamp, redis: () => (online ? adapter : null) });
    const local = await first.reserveCatalogAccess(guest, { ...request, requestedRows: 0, workUnits: 179 });
    await first.releaseCatalogAccess(local);
    online = true;
    await first.reserveCatalogAccess(guest, { ...request, requestedRows: 0 });
    await expect(backend().reserveCatalogAccess(guest, { ...request, requestedRows: 0 })).rejects.toMatchObject({
      reason: 'work',
    });
  });

  it('combines active local and Redis concurrency on a recovering instance', async () => {
    let online = false;
    const recovering = createCatalogBudgetLimiter({ now: () => timestamp, redis: () => (online ? adapter : null) });
    const localLeases = await Promise.all(
      Array.from({ length: 3 }, () => recovering.reserveCatalogAccess(guest, request)),
    );
    const remote = backend();
    await Promise.all(Array.from({ length: 3 }, () => remote.reserveCatalogAccess(guest, request)));
    online = true;
    await expect(recovering.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'concurrency' });
    await recovering.releaseCatalogAccess(localLeases[0], 0);
    await expect(recovering.reserveCatalogAccess(guest, request)).resolves.toBeDefined();
  });

  it('counts an uncertain timed-out Redis lease conservatively during recovery', async () => {
    const reply = deferred<unknown>();
    const firstApplied = deferred<void>();
    let first = true;
    const holdingAdapter: CatalogBudgetRedis = {
      eval: async (script, keyCount, ...arguments_) => {
        const holdReply = first;
        first = false;
        const result = await adapter.eval(script, keyCount, ...arguments_);
        if (!holdReply) return result;
        firstApplied.resolve();
        return reply.promise;
      },
    };
    const limiter = createCatalogBudgetLimiter({ now: () => timestamp, redis: () => holdingAdapter });
    const pending = limiter.reserveCatalogAccess(guest, request);
    await firstApplied.promise;
    const uncertainLease = await pending;
    expect(uncertainLease.mode).toBe('local');
    for (let index = 0; index < 4; index++) await limiter.reserveCatalogAccess(guest, request);
    await expect(limiter.reserveCatalogAccess(guest, request)).rejects.toMatchObject({ reason: 'concurrency' });
    reply.resolve(allowed([1, 500, 500]));
  });
});
