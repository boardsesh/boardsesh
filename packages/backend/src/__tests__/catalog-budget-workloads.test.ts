import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  createCatalogBudgetLimiter,
  type CatalogAccessLease,
  type CatalogBudgetRedis,
  type CatalogBudgetRequest,
  type CatalogIdentity,
} from '../utils/catalog-budget';

vi.mock('../redis/client', () => ({ redisClientManager: { isRedisConnected: () => false } }));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const START = Date.parse('2026-11-25T12:00:00Z');
const gymGuest: CatalogIdentity = { trustedClientIp: '198.51.100.40' };
const climber: CatalogIdentity = { ...gymGuest, userId: 'signed-in-climber' };
const read: CatalogBudgetRequest = { operation: 'climb', lane: 'interactive', requestedRows: 1 };

type ModeledRead = CatalogBudgetRequest & { actualRows: number };

// Costs match graphql/catalog-access.ts. The mobile list requests 30 rows and
// caches reads for five minutes; each modeled visitor opens three new pages,
// previews a count, opens Setters once, and inspects one previously unseen climb.
const ONE_VISITOR_MINUTE: ModeledRead[] = [
  { operation: 'setterStats', lane: 'interactive', requestedRows: 50, actualRows: 50, workUnits: 10 },
  ...Array.from({ length: 3 }, () => ({
    operation: 'searchClimbs.climbs',
    lane: 'interactive' as const,
    requestedRows: 30,
    actualRows: 30,
    workUnits: 1,
  })),
  { operation: 'searchClimbs.totalCount', lane: 'interactive', requestedRows: 0, actualRows: 0, workUnits: 3 },
  { operation: 'climb', lane: 'interactive', requestedRows: 1, actualRows: 1 },
  { operation: 'climbStatsHistory', lane: 'interactive', requestedRows: 181, actualRows: 10 },
  { operation: 'boardseshGrade', lane: 'interactive', requestedRows: 1, actualRows: 1 },
];

describe('catalog budget modeled client workloads', () => {
  it('serves twenty gym guests browsing and opening Setters within one minute', async () => {
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => null });
    let workUnits = 0;
    let actualRows = 0;
    let searchRootCalls = 0;
    let setterCalls = 0;
    for (let visitor = 0; visitor < 20; visitor++) {
      for (const operation of ONE_VISITOR_MINUTE) {
        const lease = await limiter.reserveCatalogAccess(gymGuest, operation);
        await limiter.releaseCatalogAccess(lease, operation.actualRows);
        workUnits += operation.workUnits ?? 1;
        actualRows += operation.actualRows;
        if (operation.operation.startsWith('searchClimbs.')) searchRootCalls++;
        if (operation.operation === 'setterStats') setterCalls++;
      }
    }
    expect(workUnits).toBe(380);
    expect(actualRows).toBe(3040);
    // The unchanged per-operation IP caps remain compatible with this workload.
    expect(searchRootCalls).toBe(80);
    expect(searchRootCalls).toBeLessThanOrEqual(120);
    expect(setterCalls).toBeLessThanOrEqual(60);
  });

  it('allows one signed-in screen to overlap six interactive reads with one sync page', async () => {
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => null });
    const interactive = await Promise.all(Array.from({ length: 6 }, () => limiter.reserveCatalogAccess(climber, read)));
    const sync = await limiter.reserveCatalogAccess(climber, {
      operation: 'syncClimbs',
      lane: 'sync',
      requestedRows: 500,
    });
    await expect(limiter.reserveCatalogAccess(climber, read)).rejects.toMatchObject({ reason: 'concurrency' });
    await Promise.all([...interactive, sync].map((lease) => limiter.releaseCatalogAccess(lease, 0)));
    await expect(limiter.reserveCatalogAccess(climber, read)).resolves.toBeDefined();
  });

  it('serves the observed 888 web operations/minute even if every operation costs three work units', async () => {
    const limiter = createCatalogBudgetLimiter({ now: () => START, redis: () => null });
    const service: CatalogIdentity = { service: 'www-catalog-cache' };
    const similarClimbs: CatalogBudgetRequest = {
      operation: 'similarClimbs',
      lane: 'interactive',
      requestedRows: 25,
      workUnits: 3,
    };
    let completed = 0;
    for (; completed < 888; completed++) {
      const lease = await limiter.reserveCatalogAccess(service, similarClimbs);
      await limiter.releaseCatalogAccess(lease, 12);
    }
    expect(completed * 3).toBe(2664);
    // The service still has a finite work ceiling; those remaining 336 units
    // admit 112 more calls, not an unlimited first-party exemption.
    for (; completed < 1000; completed++) {
      const lease = await limiter.reserveCatalogAccess(service, similarClimbs);
      await limiter.releaseCatalogAccess(lease, 12);
    }
    await expect(limiter.reserveCatalogAccess(service, similarClimbs)).rejects.toMatchObject({
      reason: 'work',
      retryAfterSeconds: 60,
    });
  });

  it('fits a full day at the observed web peak with twelve catalog rows per operation', async () => {
    const dayStart = Date.parse('2026-11-25T00:00:00Z');
    let timestamp = dayStart;
    const limiter = createCatalogBudgetLimiter({ now: () => timestamp, redis: () => null });
    const peakOperationsPerMinute = 888;
    const modeledRowsPerOperation = 12;
    let servedRows = 0;
    // This deliberately assumes every observed web operation returns twelve
    // catalog rows at a cost of three, and that the observed peak lasts all day.
    // It is a capacity model, not a measurement of the actual operation mix:
    // ordinary nearby reads return seven, and beta reads spend no catalog rows.
    // Minute batches preserve the fixed-window totals without simulating 1.28m
    // individual calls; the preceding test separately exercises physical calls.
    for (let minute = 0; minute < 1440; minute++) {
      timestamp = dayStart + minute * 60_000;
      const rows = peakOperationsPerMinute * modeledRowsPerOperation;
      const lease = await limiter.reserveCatalogAccess(
        { service: 'www-catalog-cache' },
        {
          operation: 'modeled-cache-minute',
          lane: 'interactive',
          requestedRows: rows,
          workUnits: peakOperationsPerMinute * 3,
        },
      );
      await limiter.releaseCatalogAccess(lease, rows);
      servedRows += rows;
    }
    expect(servedRows).toBe(15_344_640);
    expect(peakOperationsPerMinute * modeledRowsPerOperation * 60).toBe(639_360);
  });

  it('stops sustained guest pagination at the hourly row cap despite the larger burst allowance', async () => {
    let timestamp = START;
    const limiter = createCatalogBudgetLimiter({ now: () => timestamp, redis: () => null });
    let copiedRows = 0;
    for (let page = 0; page < 300; page++) {
      const lease = await limiter.reserveCatalogAccess(gymGuest, {
        operation: 'searchClimbs.climbs',
        lane: 'interactive',
        requestedRows: 100,
        workUnits: 1 + Math.floor(page / 50),
      });
      await limiter.releaseCatalogAccess(lease, 100);
      copiedRows += 100;
      // 100 search roots/minute stays below the existing 120/minute IP cap.
      timestamp += 600;
    }
    expect(copiedRows).toBe(30_000);
    expect(timestamp - START).toBe(180_000);
    await expect(limiter.reserveCatalogAccess(gymGuest, read)).rejects.toMatchObject({
      reason: 'rows',
      retryAfterSeconds: 3420,
    });
    // Changing operation or transport cannot reset the shared row budget.
    await expect(
      limiter.reserveCatalogAccess(gymGuest, { ...read, operation: 'restclimb', workUnits: 2 }),
    ).rejects.toMatchObject({ reason: 'rows' });
    timestamp = START + 3_600_000;
    await expect(limiter.reserveCatalogAccess(gymGuest, read)).resolves.toBeDefined();
  });
});

// Healthy cross-request fanout uses real Lua. The outage fallback intentionally
// permits only eight local leases, so a redis:null mock cannot prove this case.
describe.skipIf(!process.env.CATALOG_BUDGET_TEST_REDIS_URL)('catalog budget healthy gym fanout', () => {
  let client: Redis;
  let adapter: CatalogBudgetRedis;
  const touchedKeys = new Set<string>();
  const namespace = `catalog-workloads:${randomUUID()}:`;

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
  });

  afterAll(async () => {
    if (client?.status === 'ready') await client.quit();
    else client?.disconnect();
  });

  it('allows three guest views with five overlapping reads each, then caps the seventeenth', async () => {
    const replicas = Array.from({ length: 3 }, () =>
      createCatalogBudgetLimiter({ now: () => START, redis: () => adapter }),
    );
    const leases = await Promise.all(
      replicas.flatMap((limiter) => Array.from({ length: 5 }, () => limiter.reserveCatalogAccess(gymGuest, read))),
    );
    expect(leases).toHaveLength(15);
    const sixteenth = await replicas[0].reserveCatalogAccess(gymGuest, read);
    await expect(replicas[1].reserveCatalogAccess(gymGuest, read)).rejects.toMatchObject({ reason: 'concurrency' });
    await Promise.all(
      [...leases, sixteenth].map((lease: CatalogAccessLease) => replicas[2].releaseCatalogAccess(lease, 1)),
    );
    await expect(replicas[0].reserveCatalogAccess(gymGuest, read)).resolves.toBeDefined();
  });
});
