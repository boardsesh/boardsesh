/**
 * The batch family modules without a database: payload schemas, dedup
 * keys, schedules, options, and how `execute` hands the job body its reads,
 * writes and signal. The job bodies themselves run against the test database
 * in src/__tests__/batch-jobs.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbInstance } from '@boardsesh/db/client';
import type { JobDatabase } from '@boardsesh/db/jobs';

const jobs = vi.hoisted(() => ({
  runRefreshRecommendations: vi.fn(),
  runRefreshHoldFeatures: vi.fn(),
  runRefreshClimbGrades: vi.fn(),
  runRefreshClimbNeighbors: vi.fn(),
  orderBoardsByClimbCount: vi.fn(),
}));

vi.mock('@boardsesh/db/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/jobs')>();
  return { ...actual, ...jobs };
});

const { CLIMB_NEIGHBOR_BOARDS, ClimbNeighborsInterruptedError, GradeGatesFailedError } =
  await import('@boardsesh/db/jobs');
const { BackgroundJobError, familiesForRole, requireFamily } = await import('../families');
const { refreshRecommendationsFamily } = await import('../families/refresh-recommendations');
const { refreshHoldFeaturesFamily } = await import('../families/refresh-hold-features');
const { refreshClimbGradesFamily } = await import('../families/refresh-climb-grades');
const { refreshClimbNeighborsFamily } = await import('../families/refresh-climb-neighbors');

type Context = Parameters<typeof refreshRecommendationsFamily.execute>[0];

const database = { marker: 'unfenced-database' } as unknown as DbInstance;
const fencedTransaction = { marker: 'fenced-transaction' };

function context(family: Context['family']) {
  const transaction = vi.fn(async (callback: (transaction: never) => Promise<unknown>) =>
    callback(fencedTransaction as never),
  );
  const value: Context = {
    runId: '00000000-0000-4000-8000-000000000001',
    family,
    signal: new AbortController().signal,
    database,
    transaction: transaction as Context['transaction'],
  };
  return { context: value, transaction };
}

/** Run the `transact` the family handed the job body, and return what its callback saw. */
async function writeThrough(options: {
  transact: (callback: (db: JobDatabase) => Promise<unknown>) => Promise<unknown>;
}) {
  let seen: unknown;
  await options.transact(async (transaction) => {
    seen = transaction;
  });
  return seen;
}

beforeEach(() => {
  for (const mock of Object.values(jobs)) mock.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('batch family registration', () => {
  it('registers the batch families on the batch role only', () => {
    const batch = familiesForRole('batch').map((family) => family.name);
    expect(batch).toEqual(
      expect.arrayContaining([
        'refresh-recommendations',
        'refresh-hold-features',
        'refresh-climb-grades',
        'refresh-climb-neighbors',
      ]),
    );
    for (const role of ['interactive-import', 'routine-provider', 'maintenance-delivery'] as const) {
      expect(familiesForRole(role).map((family) => family.name)).toEqual(['worker-probe']);
    }
    expect(requireFamily('refresh-climb-grades')).toBe(refreshClimbGradesFamily);
    expect(requireFamily('refresh-climb-neighbors')).toBe(refreshClimbNeighborsFamily);
  });

  it('keeps each lease inside pg-boss limits and each heartbeat window valid', () => {
    for (const family of [
      refreshRecommendationsFamily,
      refreshHoldFeaturesFamily,
      refreshClimbGradesFamily,
      refreshClimbNeighborsFamily,
    ]) {
      expect(family.options.expireInSeconds).toBeLessThanOrEqual(24 * 60 * 60);
      expect(family.options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
      expect(family.options.heartbeatSeconds).toBeLessThan(family.options.expireInSeconds);
      expect(family.options.deadlineSeconds).toBeLessThan(24 * 60 * 60);
      expect(family.options.retryBackoff).toBe(true);
    }
    expect(refreshRecommendationsFamily.options).toMatchObject({
      expireInSeconds: 1200,
      retryLimit: 2,
      retryDelay: 300,
    });
    expect(refreshHoldFeaturesFamily.options).toMatchObject({ expireInSeconds: 1200, retryLimit: 2, retryDelay: 300 });
    expect(refreshClimbGradesFamily.options).toMatchObject({ expireInSeconds: 1800, retryLimit: 1, retryDelay: 900 });
    expect(refreshClimbNeighborsFamily.options).toEqual({
      expireInSeconds: 21_600,
      retryLimit: 2,
      retryDelay: 300,
      retryBackoff: true,
      retryDelayMax: 900,
      deadlineSeconds: 79_200,
      heartbeatSeconds: 60,
    });
  });

  it('schedules one nightly UTC job each, fanned out with the default payload', async () => {
    expect(refreshRecommendationsFamily.schedules?.map(({ key, cron, tz }) => ({ key, cron, tz }))).toEqual([
      { key: 'nightly', cron: '0 6 * * *', tz: undefined },
    ]);
    expect(refreshHoldFeaturesFamily.schedules?.map(({ cron }) => cron)).toEqual(['15 6 * * *']);
    expect(refreshClimbGradesFamily.schedules?.map(({ cron }) => cron)).toEqual(['30 6 * * *']);
    expect(await refreshRecommendationsFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: {} }]);
    expect(await refreshHoldFeaturesFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: { board: 'kilter' } }]);
    expect(await refreshClimbGradesFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: {} }]);
  });

  it('fans the neighbours schedule out to one job per board, cheapest first', async () => {
    expect(refreshClimbNeighborsFamily.schedules?.map(({ key, cron, tz }) => ({ key, cron, tz }))).toEqual([
      { key: 'nightly', cron: '45 6 * * *', tz: undefined },
    ]);
    jobs.orderBoardsByClimbCount.mockResolvedValue(['soill', 'touchstone', 'moonboard', 'kilter']);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T06:45:00Z')); // a Monday
    const requests = await refreshClimbNeighborsFamily.schedules?.[0].fanOut(database);
    expect(jobs.orderBoardsByClimbCount).toHaveBeenCalledWith(database, CLIMB_NEIGHBOR_BOARDS);
    expect(requests).toEqual([
      { payload: { board: 'soill', refillGaps: false } },
      { payload: { board: 'touchstone', refillGaps: false } },
      { payload: { board: 'moonboard', refillGaps: false } },
      { payload: { board: 'kilter', refillGaps: false } },
    ]);
    // Every fanned-out payload is one the worker accepts, keyed by its board.
    for (const request of requests ?? []) {
      const parsed = refreshClimbNeighborsFamily.payload.parse(request.payload);
      expect(refreshClimbNeighborsFamily.singletonKey?.(parsed)).toBe(request.payload.board);
    }
  });
});

describe('payloads and dedup keys', () => {
  it('refresh-recommendations takes an empty object and one constant key', () => {
    expect(refreshRecommendationsFamily.payload.parse({})).toEqual({});
    expect(refreshRecommendationsFamily.payload.safeParse({ board: 'kilter' }).success).toBe(false);
    expect(refreshRecommendationsFamily.singletonKey?.({})).toBe('nightly');
  });

  it('refresh-hold-features defaults to kilter and keys by board', () => {
    const parsed = refreshHoldFeaturesFamily.payload.parse({});
    expect(parsed).toEqual({ board: 'kilter' });
    expect(refreshHoldFeaturesFamily.singletonKey?.(parsed)).toBe('kilter');
    expect(
      refreshHoldFeaturesFamily.singletonKey?.(refreshHoldFeaturesFamily.payload.parse({ board: 'tension' })),
    ).toBe('tension');
    expect(refreshHoldFeaturesFamily.payload.safeParse({ board: 'Kilter; DROP' }).success).toBe(false);
    expect(refreshHoldFeaturesFamily.payload.safeParse({ board: 'kilter', dryRun: 'yes' }).success).toBe(false);
    expect(refreshHoldFeaturesFamily.payload.safeParse({ board: 'kilter', extra: true }).success).toBe(false);
  });

  it('refresh-climb-neighbors takes one materialised board and its three switches, keyed by board', () => {
    expect(refreshClimbNeighborsFamily.payload.parse({ board: 'kilter' })).toEqual({ board: 'kilter' });
    expect(refreshClimbNeighborsFamily.payload.parse({ board: 'kilter', full: true, dryRun: false })).toEqual({
      board: 'kilter',
      full: true,
      dryRun: false,
    });
    expect(refreshClimbNeighborsFamily.singletonKey?.({ board: 'moonboard' })).toBe('moonboard');
    for (const board of CLIMB_NEIGHBOR_BOARDS) {
      expect(refreshClimbNeighborsFamily.payload.safeParse({ board }).success).toBe(true);
    }
    // Spray walls are private and never materialised.
    expect(refreshClimbNeighborsFamily.payload.safeParse({ board: 'spray' }).success).toBe(false);
    expect(refreshClimbNeighborsFamily.payload.safeParse({}).success).toBe(false);
    expect(refreshClimbNeighborsFamily.payload.safeParse({ board: 'Kilter' }).success).toBe(false);
    expect(refreshClimbNeighborsFamily.payload.safeParse({ board: 'kilter', full: 'yes' }).success).toBe(false);
    expect(refreshClimbNeighborsFamily.payload.safeParse({ board: 'kilter', boards: ['tension'] }).success).toBe(false);
  });

  it('refresh-climb-grades takes only its three switches and one constant key', () => {
    expect(refreshClimbGradesFamily.payload.parse({ refit: true })).toEqual({ refit: true });
    expect(refreshClimbGradesFamily.payload.safeParse({ allowEmptyBacktest: true }).success).toBe(false);
    expect(refreshClimbGradesFamily.payload.safeParse({ contentPriorFile: '/tmp/x' }).success).toBe(false);
    expect(refreshClimbGradesFamily.singletonKey?.({ refit: true })).toBe('nightly');
  });
});

describe('execute', () => {
  it('refresh-recommendations reads unfenced, writes through the fence and reads PostHog from the environment', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'personal-key');
    vi.stubEnv('POSTHOG_PROJECT_ID', '99');
    vi.stubEnv('POSTHOG_HOST', 'https://eu.posthog.com');
    const { context: jobContext, transaction } = context('refresh-recommendations');
    await refreshRecommendationsFamily.execute(jobContext, {});
    const [options] = jobs.runRefreshRecommendations.mock.calls[0];
    expect(options).toMatchObject({
      db: database,
      signal: jobContext.signal,
      posthog: { apiKey: 'personal-key', projectId: '99', host: 'https://eu.posthog.com' },
    });
    expect(await writeThrough(options)).toBe(fencedTransaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refresh-recommendations passes no PostHog config without a key', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
    await refreshRecommendationsFamily.execute(context('refresh-recommendations').context, {});
    expect(jobs.runRefreshRecommendations.mock.calls[0][0].posthog).toBeUndefined();
  });

  it('refresh-hold-features passes the board and defaults a live, shadowed run', async () => {
    const { context: jobContext, transaction } = context('refresh-hold-features');
    await refreshHoldFeaturesFamily.execute(jobContext, refreshHoldFeaturesFamily.payload.parse({ board: 'tension' }));
    const [options] = jobs.runRefreshHoldFeatures.mock.calls[0];
    expect(options).toMatchObject({ db: database, board: 'tension', dryRun: false, shadow: true });
    expect(await writeThrough(options)).toBe(fencedTransaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refresh-climb-grades runs the production switches and writes through the fence', async () => {
    const { context: jobContext, transaction } = context('refresh-climb-grades');
    await refreshClimbGradesFamily.execute(jobContext, { refit: true });
    const [options] = jobs.runRefreshClimbGrades.mock.calls[0];
    expect(options).toMatchObject({
      db: database,
      refit: true,
      dryRun: false,
      validateOnly: false,
      allowEmptyBacktest: false,
      publishCrossAngleEstimates: false,
    });
    expect(options.contentPriorFile).toBeUndefined();
    expect(await writeThrough(options)).toBe(fencedTransaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refresh-climb-grades maps a gate failure to a non-retryable GATES_FAILED', async () => {
    jobs.runRefreshClimbGrades.mockRejectedValue(
      new GradeGatesFailedError([{ gate: 'tail_backtest', passed: false, detail: 'empty', metrics: {} }]),
    );
    const failure = await refreshClimbGradesFamily
      .execute(context('refresh-climb-grades').context, {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'GATES_FAILED', retryable: false });
  });

  it('refresh-climb-neighbors runs its one board through the fence, live and incremental by default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T06:45:00Z')); // a Monday
    const { context: jobContext, transaction } = context('refresh-climb-neighbors');
    await refreshClimbNeighborsFamily.execute(jobContext, { board: 'tension' });
    const [options] = jobs.runRefreshClimbNeighbors.mock.calls[0];
    expect(options).toMatchObject({
      db: database,
      signal: jobContext.signal,
      boards: ['tension'],
      full: false,
      dryRun: false,
      refillGaps: false,
    });
    expect(await writeThrough(options)).toBe(fencedTransaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refresh-climb-neighbors decides the gap scan at fan-out, so a retry after midnight keeps it', async () => {
    jobs.orderBoardsByClimbCount.mockResolvedValue(['soill', 'kilter']);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T06:45:00Z')); // a Sunday
    const requests = (await refreshClimbNeighborsFamily.schedules?.[0].fanOut(database)) ?? [];
    expect(requests.map(({ payload }) => payload)).toEqual([
      { board: 'soill', refillGaps: true },
      { board: 'kilter', refillGaps: true },
    ]);

    // Kilter's attempt runs (or retries) on Monday: the stored payload still scans.
    vi.setSystemTime(new Date('2026-09-28T00:30:00Z'));
    await refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors').context, requests[1].payload);
    // A Sunday execute without the field (an operator enqueue) does not scan.
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    await refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors').context, { board: 'kilter' });
    await refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors').context, {
      board: 'kilter',
      refillGaps: true,
      full: true,
    });
    expect(jobs.runRefreshClimbNeighbors.mock.calls.map(([options]) => [options.refillGaps, options.full])).toEqual([
      [true, false],
      [false, false],
      [true, true],
    ]);
  });

  it('refresh-climb-neighbors maps a stopped run to a retryable INTERRUPTED', async () => {
    jobs.runRefreshClimbNeighbors.mockRejectedValue(new ClimbNeighborsInterruptedError('kilter'));
    const failure = await refreshClimbNeighborsFamily
      .execute(context('refresh-climb-neighbors').context, { board: 'kilter' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'INTERRUPTED', retryable: true });
    const outage = new Error('connection reset');
    jobs.runRefreshClimbNeighbors.mockRejectedValue(outage);
    await expect(
      refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors').context, { board: 'kilter' }),
    ).rejects.toBe(outage);
  });

  it('refresh-climb-neighbors maps a fence abort (signal fired mid-batch) to INTERRUPTED too', async () => {
    const { context: jobContext } = context('refresh-climb-neighbors');
    const controller = new AbortController();
    jobs.runRefreshClimbNeighbors.mockImplementation(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    const failure = await refreshClimbNeighborsFamily
      .execute({ ...jobContext, signal: controller.signal }, { board: 'kilter' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'INTERRUPTED', retryable: true });
  });

  it('refresh-climb-grades lets any other failure retry', async () => {
    const outage = new Error('connection reset');
    jobs.runRefreshClimbGrades.mockRejectedValue(outage);
    await expect(refreshClimbGradesFamily.execute(context('refresh-climb-grades').context, {})).rejects.toBe(outage);
  });
});
