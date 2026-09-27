/**
 * Unit tests for the routine-provider and maintenance families: their contract
 * (payload, singleton key, schedules and fan-out, options) and how each maps
 * its runner's result or failure onto the run. The runners are mocked here;
 * their own logic is tested in their packages, and the families run for real
 * against Postgres in provider-routine-cycle.test.ts and the grant proof.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import type { DbInstance } from '@boardsesh/db/client';
import { BackgroundJobError, requireFamily, type BackgroundJobContext } from '..';
import {
  AURORA_SHARED_SYNC_COOLDOWN_MS,
  AURORA_SHARED_SYNC_DEADLINE_SECONDS,
  orderBoardsByLeastRecentSharedSync,
} from '../aurora-shared-sync';
import { KILTER_CATALOG_SYNC_COOLDOWN_MS } from '../kilter-catalog-sync';

const runners = vi.hoisted(() => ({
  runSharedSyncJob: vi.fn(),
  runCatalogSyncJob: vi.fn(),
  syncMoonBoardLocations: vi.fn(),
  auroraConfigs: [] as unknown[],
  kilterConfigs: [] as unknown[],
}));

vi.mock('@boardsesh/aurora-sync/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/aurora-sync/runner')>();
  return {
    ...actual,
    SyncRunner: class {
      constructor(config: unknown) {
        runners.auroraConfigs.push(config);
      }
      runSharedSyncJob = runners.runSharedSyncJob;
    },
  };
});

vi.mock('@boardsesh/kilter-sync/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/kilter-sync/runner')>();
  return {
    ...actual,
    SyncRunner: class {
      constructor(config: unknown) {
        runners.kilterConfigs.push(config);
      }
      runCatalogSyncJob = runners.runCatalogSyncJob;
    },
  };
});

vi.mock('@boardsesh/moonboard-sync/sync', () => ({ syncMoonBoardLocations: runners.syncMoonBoardLocations }));

const { AuroraRequestError } = await import('@boardsesh/aurora-sync/api');
const { KilterApiError } = await import('@boardsesh/kilter-sync/api');

/** A context whose database and transaction fail the test if anything touches them. */
function fakeContext(family: BackgroundJobContext['family']): BackgroundJobContext & {
  transaction: ReturnType<typeof vi.fn>;
} {
  const untouchable = new Proxy(
    {},
    {
      get(_target, property) {
        if (
          typeof property === 'string' &&
          ['select', 'insert', 'update', 'delete', 'execute', 'transaction'].includes(property)
        ) {
          throw new Error(`database.${property} used`);
        }
        return undefined;
      },
    },
  ) as DbInstance;
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    family,
    signal: new AbortController().signal,
    expiresAt: Date.now() + 60 * 60 * 1000,
    enqueue: async () => {
      throw new Error('enqueue not expected');
    },
    database: untouchable,
    transaction: vi.fn(async () => {
      throw new Error('transaction used');
    }),
  };
}

beforeEach(() => {
  runners.runSharedSyncJob.mockReset();
  runners.runCatalogSyncJob.mockReset();
  runners.syncMoonBoardLocations.mockReset();
  runners.auroraConfigs.length = 0;
  runners.kilterConfigs.length = 0;
  vi.unstubAllEnvs();
});

describe('family contracts', () => {
  it('provider-routine-cycle: one cycle per provider every 5 minutes, keyed by provider', async () => {
    const family = requireFamily('provider-routine-cycle');
    expect(family.roles).toEqual(['routine-provider']);
    expect(family.options).toMatchObject({
      expireInSeconds: 600,
      retryLimit: 0,
      // Longer than the lease: a cycle may wait behind an hour-long board-wide job.
      deadlineSeconds: AURORA_SHARED_SYNC_DEADLINE_SECONDS,
      heartbeatSeconds: 300,
    });
    expect(family.payload.safeParse({ provider: 'aurora' }).success).toBe(true);
    expect(family.payload.safeParse({ provider: 'moonboard' }).success).toBe(false);
    expect(family.payload.safeParse({ provider: 'kilter', userId: 'x' }).success).toBe(false);
    expect(family.singletonKey?.({ provider: 'kilter' })).toBe('kilter');
    expect(family.schedules?.map(({ key, cron }) => ({ key, cron }))).toEqual([
      { key: 'every-5-min', cron: '*/5 * * * *' },
    ]);
    expect(await family.schedules![0].fanOut({} as DbInstance)).toEqual([
      { payload: { provider: 'aurora' } },
      { payload: { provider: 'kilter' } },
    ]);
  });

  it('aurora-shared-sync: hourly at :07, one run per Aurora board but Kilter, keyed by board', async () => {
    const family = requireFamily('aurora-shared-sync');
    expect(family.roles).toEqual(['routine-provider']);
    expect(family.options).toMatchObject({
      expireInSeconds: 3600,
      retryLimit: 1,
      retryDelay: 300,
      deadlineSeconds: AURORA_SHARED_SYNC_DEADLINE_SECONDS,
      heartbeatSeconds: 300,
      priority: 0,
    });
    // Five boards queue behind each other on the one-at-a-time worker, each
    // with an hour's lease: the last one's deadline must outlast the other four.
    const boardCount = AURORA_BOARDS.filter((board) => board !== 'kilter').length;
    expect(AURORA_SHARED_SYNC_DEADLINE_SECONDS).toBeGreaterThan(boardCount * 3600);
    expect(family.payload.safeParse({ board: 'kilter' }).success).toBe(false);
    expect(family.singletonKey?.({ board: 'decoy' })).toBe('decoy');
    expect(family.schedules?.map(({ key, cron }) => ({ key, cron }))).toEqual([{ key: 'hourly', cron: '7 * * * *' }]);
    // decoy ran most recently, tension an hour before it, the rest never.
    const stampRows = [
      { boardType: 'decoy', stamp: '2026-09-27 10:07:00.000000#finished:x' },
      { boardType: 'tension', stamp: '2026-09-27 09:07:00.000000' },
    ];
    const database = {
      select: () => ({ from: () => ({ where: async () => stampRows }) }),
    } as unknown as DbInstance;
    const boards = (await family.schedules![0].fanOut(database)).map(
      (request) => (request.payload as { board: string }).board,
    );
    expect([...boards].sort()).toEqual(AURORA_BOARDS.filter((board) => board !== 'kilter').sort());
    expect(boards.slice(-2)).toEqual(['tension', 'decoy']);
  });

  it('orders the shared sync fan-out never-run first, then oldest stamp first, ties in list order', () => {
    expect(
      orderBoardsByLeastRecentSharedSync(
        ['a', 'b', 'c', 'd'],
        new Map<string, string | null>([
          ['a', '2026-09-27 10:00:00.000000'],
          ['b', '2026-09-27 08:00:00.000000#claim:x'],
          ['c', null],
          ['d', 'not a stamp'],
        ]),
      ),
    ).toEqual(['c', 'd', 'b', 'a']);
  });

  it('kilter-catalog-sync, moonboard-locations-sync and climb-stats-self-heal: one run per tick', async () => {
    const cases = [
      {
        name: 'kilter-catalog-sync',
        role: 'routine-provider',
        cron: '23 * * * *',
        options: {
          expireInSeconds: 3600,
          retryLimit: 1,
          retryDelay: 300,
          deadlineSeconds: AURORA_SHARED_SYNC_DEADLINE_SECONDS,
          heartbeatSeconds: 300,
          priority: 0,
        },
      },
      {
        name: 'moonboard-locations-sync',
        role: 'routine-provider',
        cron: '41 3 * * *',
        options: {
          expireInSeconds: 1800,
          retryLimit: 1,
          retryDelay: 600,
          deadlineSeconds: 86400,
          heartbeatSeconds: 120,
          priority: 0,
        },
      },
      {
        name: 'climb-stats-self-heal',
        role: 'maintenance-delivery',
        cron: '13 * * * *',
        options: { expireInSeconds: 900, retryLimit: 1, retryDelay: 300, deadlineSeconds: 3600, heartbeatSeconds: 120 },
      },
    ];
    for (const { name, role, cron, options } of cases) {
      const family = requireFamily(name);
      expect(family.roles).toEqual([role]);
      expect(family.options).toMatchObject(options);
      expect(family.payload.safeParse({}).success).toBe(true);
      expect(family.payload.safeParse({ extra: 1 }).success).toBe(false);
      expect(family.schedules).toHaveLength(1);
      expect(family.schedules![0].cron).toBe(cron);
      expect(await family.schedules![0].fanOut({} as DbInstance)).toEqual([{ payload: {} }]);
      // One key per family: a slow run never piles up more than one successor.
      expect(family.singletonKey?.({})).toBeTruthy();
    }
  });

  it('keeps every retry option pg-boss accepts: retryDelayMax only ever rides with backoff', () => {
    for (const name of [
      'provider-routine-cycle',
      'aurora-shared-sync',
      'kilter-catalog-sync',
      'moonboard-locations-sync',
      'climb-stats-self-heal',
    ]) {
      const { options } = requireFamily(name);
      expect(options.retryBackoff).toBe(true);
      expect(options.retryDelayMax).toBeGreaterThanOrEqual(options.retryDelay);
      expect(options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('aurora-shared-sync execute', () => {
  const family = requireFamily('aurora-shared-sync');

  it('runs the board through the attempt fence with the 50-minute claim', async () => {
    runners.runSharedSyncJob.mockResolvedValue({ status: 'synced', tokenSource: 'stored' });
    const context = fakeContext('aurora-shared-sync');

    await family.execute(context, { board: 'tension' });

    expect(runners.runSharedSyncJob).toHaveBeenCalledWith('tension', {
      transaction: context.transaction,
      signal: context.signal,
      cooldownMs: AURORA_SHARED_SYNC_COOLDOWN_MS,
      // The retry of this run re-claims the slot it left claimed.
      runId: context.runId,
    });
    expect(runners.auroraConfigs[0]).toMatchObject({ db: context.database, signal: context.signal });
  });

  it.each([
    { status: 'cooldown', lastRunAt: new Date('2026-09-27T11:07:00Z') },
    { status: 'cooldown', lastRunAt: null },
    { status: 'no_donor' },
  ])('succeeds without work on %j', async (result) => {
    runners.runSharedSyncJob.mockResolvedValue(result);
    await expect(family.execute(fakeContext('aurora-shared-sync'), { board: 'decoy' })).resolves.toBeUndefined();
  });

  it('maps a transient Aurora failure to a retryable PROVIDER_UNAVAILABLE', async () => {
    runners.runSharedSyncJob.mockRejectedValue(new AuroraRequestError({ code: 'timeout', message: 'timed out' }));
    const failure = await family.execute(fakeContext('aurora-shared-sync'), { board: 'decoy' }).catch((error) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('ends as a logged PROVIDER_THROTTLED success on a 429 with Retry-After: no pg-boss retry into the hold', async () => {
    runners.runSharedSyncJob.mockRejectedValue(
      new AuroraRequestError({ code: 'rate_limited', message: 'slow down', status: 429, retryAfterMs: 3_600_000 }),
    );
    await expect(family.execute(fakeContext('aurora-shared-sync'), { board: 'decoy' })).resolves.toBeUndefined();
  });

  it('maps a permanent Aurora failure to SHARED_SYNC_FAILED without a retry', async () => {
    runners.runSharedSyncJob.mockRejectedValue(
      new AuroraRequestError({ code: 'http', message: 'Aurora HTTP 400', status: 400 }),
    );
    const failure = await family.execute(fakeContext('aurora-shared-sync'), { board: 'decoy' }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'SHARED_SYNC_FAILED', retryable: false });
  });

  it('lets a database error through untouched, so it records ATTEMPT_FAILED and retries', async () => {
    const databaseError = new Error('permission denied for table board_kits');
    runners.runSharedSyncJob.mockRejectedValue(databaseError);
    await expect(family.execute(fakeContext('aurora-shared-sync'), { board: 'decoy' })).rejects.toBe(databaseError);
  });
});

describe('kilter-catalog-sync execute', () => {
  const family = requireFamily('kilter-catalog-sync');

  it('claims with the 50-minute cooldown, the run signal and the attempt fence', async () => {
    runners.runCatalogSyncJob.mockResolvedValue({ status: 'synced', tokenSource: 'credential' });
    const context = fakeContext('kilter-catalog-sync');

    await family.execute(context, {});

    // Every write batch of the job goes through the attempt fence.
    expect(runners.runCatalogSyncJob).toHaveBeenCalledWith({
      signal: context.signal,
      transaction: context.transaction,
      cooldownMs: KILTER_CATALOG_SYNC_COOLDOWN_MS,
      runId: context.runId,
    });
  });

  it.each([{ status: 'cooldown', lastRunAt: null }, { status: 'no_donor' }])(
    'succeeds without work on %j',
    async (result) => {
      runners.runCatalogSyncJob.mockResolvedValue(result);
      await expect(family.execute(fakeContext('kilter-catalog-sync'), {})).resolves.toBeUndefined();
    },
  );

  it('retries an unreachable Kilter, waits out a Retry-After, and gives up on a permanent refusal', async () => {
    runners.runCatalogSyncJob.mockRejectedValueOnce(new KilterApiError('rate_limited', 'slow down', 429));
    await expect(family.execute(fakeContext('kilter-catalog-sync'), {})).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // With a Retry-After the runner already closed the slot for that long: a
    // logged PROVIDER_THROTTLED success, no retry into the hold.
    runners.runCatalogSyncJob.mockRejectedValueOnce(new KilterApiError('rate_limited', 'slow down', 429, 3_600_000));
    await expect(family.execute(fakeContext('kilter-catalog-sync'), {})).resolves.toBeUndefined();
    runners.runCatalogSyncJob.mockRejectedValueOnce(new KilterApiError('invalid_grant', 'relink'));
    await expect(family.execute(fakeContext('kilter-catalog-sync'), {})).rejects.toMatchObject({
      code: 'CATALOG_SYNC_FAILED',
      retryable: false,
    });
  });
});

describe('moonboard-locations-sync execute', () => {
  const family = requireFamily('moonboard-locations-sync');

  it('succeeds as a skip without credentials: no login, no transaction, no freshness write', async () => {
    vi.stubEnv('MOONBOARD_USERNAME', '');
    vi.stubEnv('MOONBOARD_PASSWORD', '');
    const context = fakeContext('moonboard-locations-sync');

    await expect(family.execute(context, {})).resolves.toBeUndefined();

    expect(runners.syncMoonBoardLocations).not.toHaveBeenCalled();
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it('syncs with the operator account, writing through the attempt fence', async () => {
    vi.stubEnv('MOONBOARD_USERNAME', 'operator@example.com');
    vi.stubEnv('MOONBOARD_PASSWORD', 'secret');
    runners.syncMoonBoardLocations.mockResolvedValue({
      boardsSeen: 9,
      boardsUpserted: 9,
      boardsSkipped: 0,
      gymsSeen: 1,
      gymsUpserted: 1,
      skipped: [],
    });
    const context = fakeContext('moonboard-locations-sync');

    await family.execute(context, {});

    expect(runners.syncMoonBoardLocations).toHaveBeenCalledWith(
      expect.objectContaining({
        db: context.database,
        transaction: context.transaction,
        signal: context.signal,
        username: 'operator@example.com',
        password: 'secret',
      }),
    );
  });
});
