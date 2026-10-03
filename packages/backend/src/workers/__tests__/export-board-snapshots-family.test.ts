/**
 * The export-board-snapshots family without a database or S3: payload schema,
 * dedup key, both schedules, options, the live-scan staleness skip, the
 * nightly's pass order and failure rules, and the fence it hands the exporter.
 * The exporter itself runs against the test database in
 * src/__tests__/snapshot-export-run.test.ts and, under the batch login, in
 * src/services/__tests__/job-queue-roles-snapshots.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbInstance } from '@boardsesh/db/client';
import type { SnapshotExportDependencies, SnapshotExportOptions } from '../../scripts/export-board-snapshots';

const exporter = vi.hoisted(() => ({
  runExportWithOptions: vi.fn(),
  runCatalogExportWithOptions: vi.fn(),
  isS3Configured: vi.fn(),
  snapshotPublicBaseUrl: vi.fn(),
}));

vi.mock('../../scripts/export-board-snapshots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/export-board-snapshots')>();
  return {
    ...actual,
    runExportWithOptions: exporter.runExportWithOptions,
    snapshotPublicBaseUrl: exporter.snapshotPublicBaseUrl,
  };
});
vi.mock('../../scripts/export-board-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/export-board-catalog')>();
  return { ...actual, runCatalogExportWithOptions: exporter.runCatalogExportWithOptions };
});
vi.mock('../../storage/s3', () => ({
  isS3Configured: exporter.isS3Configured,
  uploadToS3: vi.fn(),
  getPublicUrl: vi.fn(),
  getFromS3Strict: vi.fn(),
  deleteFromS3: vi.fn(),
  listS3Objects: vi.fn(),
}));

const { familiesForRole, requireFamily } = await import('../families');
const {
  ACTIVE_RUN_WINDOW_SECONDS,
  LIVE_SCAN_MAX_AGE_SECONDS,
  LIVE_SCAN_REFRESH_THRESHOLD,
  exportBoardSnapshotsFamily: family,
} = await import('../families/export-board-snapshots');

type Context = Parameters<typeof family.execute>[0];
type ExportCall = [SnapshotExportOptions, SnapshotExportDependencies];

type FakeDatabaseOptions = {
  readsAllStats?: boolean;
  ageSeconds?: number | null;
  attemptNumber?: number;
  otherRunActive?: boolean;
};

/**
 * A database that answers the family's reads: the stats grant, this run's age
 * and attempt, and whether another snapshot run is running.
 */
function fakeDatabase(options: FakeDatabaseOptions = {}) {
  const { readsAllStats = true, ageSeconds = 5, attemptNumber = 0, otherRunActive = false } = options;
  return {
    execute: vi.fn(async () => [{ reads_all_stats: readsAllStats }]),
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if ('ageSeconds' in fields) {
            return Promise.resolve(ageSeconds === null ? [] : [{ ageSeconds: String(ageSeconds), attemptNumber }]);
          }
          return { limit: async () => (otherRunActive ? [{ id: 'other-run' }] : []) };
        },
      }),
    })),
  } as unknown as DbInstance;
}

function context(options: FakeDatabaseOptions & { signal?: AbortSignal } = {}) {
  const fencedStatements: unknown[] = [];
  const transaction = vi.fn(async (callback: (transaction: never) => Promise<unknown>) =>
    callback({ execute: async (statement: unknown) => fencedStatements.push(statement) } as never),
  );
  const value: Context = {
    runId: '00000000-0000-4000-8000-000000000001',
    family: 'export-board-snapshots',
    signal: options.signal ?? new AbortController().signal,
    expiresAt: Date.now() + 60 * 60 * 1000,
    enqueue: async () => {
      throw new Error('enqueue not expected');
    },
    database: fakeDatabase(options),
    transaction: transaction as Context['transaction'],
  };
  return { context: value, transaction, fencedStatements };
}

function exportCalls(): ExportCall[] {
  return exporter.runExportWithOptions.mock.calls as ExportCall[];
}

beforeEach(() => {
  for (const mock of Object.values(exporter)) mock.mockReset();
  exporter.isS3Configured.mockReturnValue(true);
  exporter.snapshotPublicBaseUrl.mockReturnValue('https://boardsesh-board-snapshots.t3.tigrisfiles.io');
  exporter.runExportWithOptions.mockResolvedValue(undefined);
  exporter.runCatalogExportWithOptions.mockResolvedValue(undefined);
});

describe('registration, schedules and options', () => {
  it('is a batch-only family', () => {
    expect(requireFamily('export-board-snapshots')).toBe(family);
    expect(family.roles).toEqual(['batch']);
    expect(familiesForRole('batch').map(({ name }) => name)).toContain('export-board-snapshots');
    expect(familiesForRole('routine-provider').map(({ name }) => name)).not.toContain('export-board-snapshots');
  });

  it('schedules the nightly at 07:15 and keeps live scans clear of its 07:00 window', async () => {
    expect(family.schedules?.map(({ key, cron, tz }) => ({ key, cron, tz }))).toEqual([
      { key: 'nightly', cron: '15 7 * * *', tz: undefined },
      { key: 'live-scan', cron: '7,22,37,52 0-6,8-23 * * *', tz: undefined },
    ]);
    const database = fakeDatabase();
    expect(await family.schedules?.[0].fanOut(database)).toEqual([{ payload: { mode: 'nightly' } }]);
    expect(await family.schedules?.[1].fanOut(database)).toEqual([{ payload: { mode: 'live-scan' } }]);
  });

  it('keys each mode separately, so a queued scan can never drop the nightly', () => {
    expect(family.singletonKey?.({ mode: 'nightly' })).toBe('nightly');
    expect(family.singletonKey?.({ mode: 'live-scan' })).toBe('live-scan');
    expect(family.singletonKey?.({ mode: 'nightly', board: 'kilter', layout: 8 })).toBe('nightly');
  });

  it("keeps the workflow's 45-minute budget, one retry after 300 s and a valid heartbeat", () => {
    expect(family.options).toMatchObject({
      expireInSeconds: 2700,
      retryLimit: 1,
      retryDelay: 300,
      deadlineSeconds: 72_000,
    });
    expect(family.options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
    expect(family.options.heartbeatSeconds).toBeLessThan(family.options.expireInSeconds);
    expect(family.options.retryDelayMax).toBeGreaterThanOrEqual(family.options.retryDelay);
  });

  it('counts another run as running for three heartbeat windows, not one', () => {
    expect(ACTIVE_RUN_WINDOW_SECONDS).toBe(3 * family.options.heartbeatSeconds);
  });
});

describe('payload', () => {
  const accepts = (value: unknown) => family.payload.safeParse(value).success;

  it('accepts both modes and the operator filters', () => {
    expect(family.payload.parse({ mode: 'nightly' })).toEqual({ mode: 'nightly' });
    expect(family.payload.parse({ mode: 'live-scan' })).toEqual({ mode: 'live-scan' });
    expect(accepts({ mode: 'nightly', board: 'kilter', layout: 8, gzipOnly: true })).toBe(true);
    expect(accepts({ mode: 'live-scan', board: 'tension', refreshThreshold: 100 })).toBe(true);
  });

  it('rejects a missing or unknown mode, unknown keys and malformed filters', () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ mode: 'full' })).toBe(false);
    expect(accepts({ mode: 'nightly', dryRun: true })).toBe(false);
    expect(accepts({ mode: 'nightly', storageTarget: 'r2' })).toBe(false);
    expect(accepts({ mode: 'nightly', board: 'Kilter; DROP' })).toBe(false);
    expect(accepts({ mode: 'nightly', board: 'kilter', layout: 1.5 })).toBe(false);
    expect(accepts({ mode: 'nightly', board: 'kilter', layout: '8' })).toBe(false);
    expect(accepts({ mode: 'live-scan', refreshThreshold: 0 })).toBe(false);
  });

  it('needs a board for a layout, and takes gzipOnly on the nightly only', () => {
    expect(accepts({ mode: 'nightly', layout: 8 })).toBe(false);
    expect(accepts({ mode: 'live-scan', gzipOnly: true })).toBe(false);
  });
});

describe('guards', () => {
  it('refuses to run without snapshot storage, without retrying', async () => {
    exporter.isS3Configured.mockReturnValue(false);
    await expect(family.execute(context().context, { mode: 'nightly' })).rejects.toMatchObject({
      code: 'SNAPSHOT_STORAGE_UNCONFIGURED',
      retryable: false,
    });
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
  });

  it('refuses to publish store URLs the fleet cannot read', async () => {
    exporter.snapshotPublicBaseUrl.mockReturnValue('');
    await expect(family.execute(context().context, { mode: 'live-scan' })).rejects.toMatchObject({
      code: 'SNAPSHOT_PUBLIC_BASE_URL_UNSET',
      retryable: false,
    });
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
  });

  it('logs whether the login holds pg_read_all_stats before refusing a login without it', async () => {
    const { logger } = await import('../../utils/logger');
    const info = vi.fn();
    const child = vi
      .spyOn(logger, 'child')
      .mockReturnValue({ info, warn: vi.fn(), error: vi.fn() } as unknown as ReturnType<typeof logger.child>);
    try {
      await expect(
        family.execute(context({ readsAllStats: false }).context, { mode: 'live-scan' }),
      ).rejects.toMatchObject({ code: 'SNAPSHOT_OBSERVER_UNPRIVILEGED' });
      expect(info).toHaveBeenCalledWith('[export-snapshots] replay observer grant', {
        mode: 'live-scan',
        readsAllStats: false,
      });
    } finally {
      child.mockRestore();
    }
  });

  it('refuses a login that cannot see the writers’ transactions', async () => {
    await expect(family.execute(context({ readsAllStats: false }).context, { mode: 'nightly' })).rejects.toMatchObject({
      code: 'SNAPSHOT_OBSERVER_UNPRIVILEGED',
      retryable: false,
    });
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
  });
});

describe('live scan', () => {
  it('refreshes the live gzip prefix at the 500-row threshold', async () => {
    const { context: jobContext } = context();
    await family.execute(jobContext, { mode: 'live-scan' });
    expect(exportCalls()).toHaveLength(1);
    const [[options, dependencies]] = exportCalls();
    expect(options).toEqual({
      dryRun: false,
      gzip: true,
      keyPrefix: 'board-snapshots/v1-gzip',
      source: 'primary',
      fence: false,
      heartbeat: false,
      refreshThreshold: LIVE_SCAN_REFRESH_THRESHOLD,
      boardFilter: undefined,
      layoutFilter: undefined,
    });
    expect(LIVE_SCAN_REFRESH_THRESHOLD).toBe(500);
    expect(dependencies.signal).toBe(jobContext.signal);
    expect(dependencies.requireAllRolesVisible).toBe(true);
    expect(exporter.runCatalogExportWithOptions).not.toHaveBeenCalled();
  });

  it('passes an operator threshold and filters through', async () => {
    await family.execute(context().context, {
      mode: 'live-scan',
      board: 'kilter',
      layout: 8,
      refreshThreshold: 50,
    });
    expect(exportCalls()[0][0]).toMatchObject({ refreshThreshold: 50, boardFilter: 'kilter', layoutFilter: 8 });
  });

  it('skips, and succeeds, when its first attempt waited longer than 14 minutes to start', async () => {
    await expect(
      family.execute(context({ ageSeconds: LIVE_SCAN_MAX_AGE_SECONDS + 1 }).context, { mode: 'live-scan' }),
    ).resolves.toBeUndefined();
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
  });

  it('fails a retry that old, so a scan that keeps failing never reads green', async () => {
    await expect(
      family.execute(context({ ageSeconds: LIVE_SCAN_MAX_AGE_SECONDS + 1, attemptNumber: 1 }).context, {
        mode: 'live-scan',
      }),
    ).rejects.toMatchObject({ code: 'LIVE_SCAN_STALE', retryable: false });
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
  });

  it('runs a retry that is still inside the age limit', async () => {
    await family.execute(context({ ageSeconds: 600, attemptNumber: 1 }).context, { mode: 'live-scan' });
    expect(exporter.runExportWithOptions).toHaveBeenCalledTimes(1);
  });

  it('yields, and succeeds, while another snapshot run is running', async () => {
    await expect(
      family.execute(context({ otherRunActive: true }).context, { mode: 'live-scan' }),
    ).resolves.toBeUndefined();
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
  });

  it('runs right up to the age limit', async () => {
    await family.execute(context({ ageSeconds: LIVE_SCAN_MAX_AGE_SECONDS }).context, { mode: 'live-scan' });
    expect(exporter.runExportWithOptions).toHaveBeenCalledTimes(1);
  });

  it('never applies the age limit to the nightly', async () => {
    await family.execute(context({ ageSeconds: 3 * 60 * 60, attemptNumber: 1 }).context, { mode: 'nightly' });
    expect(exporter.runExportWithOptions).toHaveBeenCalledTimes(2);
  });
});

describe('nightly', () => {
  it('retries later while another snapshot run is running', async () => {
    await expect(family.execute(context({ otherRunActive: true }).context, { mode: 'nightly' })).rejects.toMatchObject({
      code: 'SNAPSHOT_RUN_ACTIVE',
      retryable: true,
    });
    expect(exporter.runExportWithOptions).not.toHaveBeenCalled();
    expect(exporter.runCatalogExportWithOptions).not.toHaveBeenCalled();
  });

  it('runs identity, then gzip, then the catalogue, like the workflow', async () => {
    const order: string[] = [];
    exporter.runExportWithOptions.mockImplementation(async (options: SnapshotExportOptions) => {
      order.push(options.keyPrefix);
    });
    exporter.runCatalogExportWithOptions.mockImplementation(async (options: { keyPrefix: string }) => {
      order.push(options.keyPrefix);
    });
    await family.execute(context().context, { mode: 'nightly' });
    expect(order).toEqual(['board-snapshots/v1', 'board-snapshots/v1-gzip', 'board-snapshots/v1-catalog']);
    expect(exportCalls().map(([options]) => options)).toEqual([
      {
        dryRun: false,
        gzip: false,
        keyPrefix: 'board-snapshots/v1',
        source: 'primary',
        fence: false,
        heartbeat: false,
        boardFilter: undefined,
        layoutFilter: undefined,
      },
      {
        dryRun: false,
        gzip: true,
        keyPrefix: 'board-snapshots/v1-gzip',
        source: 'primary',
        fence: false,
        heartbeat: false,
        refreshThreshold: undefined,
        boardFilter: undefined,
        layoutFilter: undefined,
      },
    ]);
    expect(exporter.runCatalogExportWithOptions).toHaveBeenCalledWith(
      { dryRun: false, keyPrefix: 'board-snapshots/v1-catalog' },
      expect.objectContaining({ requireAllRolesVisible: true }),
    );
  });

  it('logs a catalogue failure and still succeeds', async () => {
    exporter.runCatalogExportWithOptions.mockRejectedValue(new Error('catalogue exploded'));
    await expect(family.execute(context().context, { mode: 'nightly' })).resolves.toBeUndefined();
    expect(exporter.runExportWithOptions).toHaveBeenCalledTimes(2);
  });

  it('still runs the fleet-facing gzip pass after an identity failure, then fails the run', async () => {
    exporter.runExportWithOptions.mockImplementation(async (options: SnapshotExportOptions) => {
      if (!options.gzip) throw new Error('Export failed for 1 layout(s): kilter:8');
    });
    await expect(family.execute(context().context, { mode: 'nightly' })).rejects.toMatchObject({
      code: 'SNAPSHOT_PASS_FAILED',
      retryable: true,
    });
    expect(exportCalls().map(([options]) => options.keyPrefix)).toEqual([
      'board-snapshots/v1',
      'board-snapshots/v1-gzip',
    ]);
  });

  it('stops at once when the attempt is aborted', async () => {
    const abort = new AbortController();
    exporter.runExportWithOptions.mockImplementation(async () => {
      abort.abort();
      throw new Error('aborted');
    });
    await expect(family.execute(context({ signal: abort.signal }).context, { mode: 'nightly' })).rejects.toThrow(
      'aborted',
    );
    expect(exporter.runExportWithOptions).toHaveBeenCalledTimes(1);
    expect(exporter.runCatalogExportWithOptions).not.toHaveBeenCalled();
  });

  it('stops at once when the fence refuses the attempt', async () => {
    const { context: jobContext, transaction } = context();
    transaction.mockRejectedValue(new Error('ATTEMPT_LOST'));
    exporter.runExportWithOptions.mockImplementation(async (_options, dependencies: SnapshotExportDependencies) => {
      await dependencies.beforeManifestPublish?.();
    });
    await expect(family.execute(jobContext, { mode: 'nightly' })).rejects.toThrow('ATTEMPT_LOST');
    expect(exporter.runExportWithOptions).toHaveBeenCalledTimes(1);
  });

  it('skips the identity pass on gzipOnly, like the gzip_only dispatch input', async () => {
    await family.execute(context().context, { mode: 'nightly', gzipOnly: true });
    expect(exportCalls().map(([options]) => options.keyPrefix)).toEqual(['board-snapshots/v1-gzip']);
    expect(exporter.runCatalogExportWithOptions).toHaveBeenCalledTimes(1);
  });

  it('narrows like a workflow dispatch: a threshold skips identity and catalogue, a board the catalogue', async () => {
    await family.execute(context().context, { mode: 'nightly', refreshThreshold: 200 });
    expect(exportCalls().map(([options]) => [options.keyPrefix, options.refreshThreshold])).toEqual([
      ['board-snapshots/v1-gzip', 200],
    ]);
    expect(exporter.runCatalogExportWithOptions).not.toHaveBeenCalled();

    exporter.runExportWithOptions.mockClear();
    await family.execute(context().context, { mode: 'nightly', board: 'kilter', layout: 8 });
    expect(exportCalls().map(([options]) => [options.keyPrefix, options.boardFilter, options.layoutFilter])).toEqual([
      ['board-snapshots/v1', 'kilter', 8],
      ['board-snapshots/v1-gzip', 'kilter', 8],
    ]);
    expect(exporter.runCatalogExportWithOptions).not.toHaveBeenCalled();
  });
});

describe('the fence before each manifest', () => {
  it('runs one SELECT 1 through the attempt fence and nothing else', async () => {
    const { context: jobContext, transaction, fencedStatements } = context();
    await family.execute(jobContext, { mode: 'live-scan' });
    const [[, dependencies]] = exportCalls();
    expect(transaction).not.toHaveBeenCalled();
    await dependencies.beforeManifestPublish?.();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(fencedStatements).toHaveLength(1);
  });

  it('hands every pass the same fence', async () => {
    await family.execute(context().context, { mode: 'nightly' });
    const fences = [
      ...exportCalls().map(([, dependencies]) => dependencies.beforeManifestPublish),
      (exporter.runCatalogExportWithOptions.mock.calls[0] as ExportCall)[1].beforeManifestPublish,
    ];
    expect(fences).toHaveLength(3);
    for (const fence of fences) expect(fence).toBe(fences[0]);
  });
});
