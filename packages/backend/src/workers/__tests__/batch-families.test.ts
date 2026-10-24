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
  runMoonboardAngleEstimates: vi.fn(),
  runMoonboardWideAngleEstimates: vi.fn(),
  computeSprayWallHealth: vi.fn(),
}));

vi.mock('@boardsesh/db/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/jobs')>();
  return { ...actual, ...jobs };
});

// The wall-health and community-recap families capture PostHog events; the
// real client is environment-gated, so the test pins the CALL instead.
const capture = vi.hoisted(() => ({
  captureBackendEvent: vi.fn(
    (
      _eventName: string,
      _options: {
        systemDistinctId: `system:${string}`;
        properties?: Record<string, string | number | boolean | null>;
        timestamp?: Date;
        uuid?: string;
      },
    ): boolean => false,
  ),
  flushBackendEvents: vi.fn(async (): Promise<void> => {}),
}));
vi.mock('../../services/analytics/posthog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/analytics/posthog')>();
  return { ...actual, ...capture };
});

// The recap's queries run against the test database in
// services/__tests__/community-monthly-stats.test.ts; here only the hand-off.
const recap = vi.hoisted(() => ({ computeCommunityMonthlyStats: vi.fn() }));
vi.mock('../../services/community-monthly-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/community-monthly-stats')>();
  return { ...actual, ...recap };
});

const {
  CLIMB_NEIGHBOR_BOARDS,
  ClimbNeighborsInterruptedError,
  GradeGatesFailedError,
  MoonboardFitUnusableError,
  SprayWallHealthInputError,
} = await import('@boardsesh/db/jobs');
const { BackgroundJobError, familiesForRole, requireFamily } = await import('../families');
const { refreshRecommendationsFamily } = await import('../families/refresh-recommendations');
const { refreshHoldFeaturesFamily } = await import('../families/refresh-hold-features');
const { refreshClimbGradesFamily } = await import('../families/refresh-climb-grades');
const { refreshClimbNeighborsFamily } = await import('../families/refresh-climb-neighbors');
const { refreshMoonboardAngleEstimatesFamily } = await import('../families/refresh-moonboard-angle-estimates');
const { refreshMoonboardWideAngleEstimatesFamily } = await import('../families/refresh-moonboard-wide-angle-estimates');
const { sprayWallHealthFamily } = await import('../families/spray-wall-health');
const { communityMonthlyStatsFamily } = await import('../families/community-monthly-stats');
const { logger } = await import('../../utils/logger');

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
    expiresAt: Date.now() + 60 * 60 * 1000,
    enqueue: async () => {
      throw new Error('enqueue not expected');
    },
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
        'refresh-moonboard-angle-estimates',
        'refresh-moonboard-wide-angle-estimates',
        'spray-wall-health',
        'community-monthly-stats',
      ]),
    );
    expect(familiesForRole('interactive-import').map((family) => family.name)).toEqual([
      'worker-probe',
      'aurora-user-sync',
      'kilter-user-sync',
    ]);
    expect(familiesForRole('routine-provider').map((family) => family.name)).toEqual([
      'worker-probe',
      'provider-routine-cycle',
      'aurora-shared-sync',
      'kilter-catalog-sync',
      'moonboard-locations-sync',
    ]);
    expect(familiesForRole('maintenance-delivery').map((family) => family.name)).toEqual([
      'worker-probe',
      'climb-stats-self-heal',
      'user-data-export',
      'spray-wall-art',
    ]);
    expect(requireFamily('refresh-climb-grades')).toBe(refreshClimbGradesFamily);
    expect(requireFamily('refresh-climb-neighbors')).toBe(refreshClimbNeighborsFamily);
    expect(requireFamily('refresh-moonboard-angle-estimates')).toBe(refreshMoonboardAngleEstimatesFamily);
    expect(requireFamily('refresh-moonboard-wide-angle-estimates')).toBe(refreshMoonboardWideAngleEstimatesFamily);
    expect(requireFamily('spray-wall-health')).toBe(sprayWallHealthFamily);
    expect(requireFamily('community-monthly-stats')).toBe(communityMonthlyStatsFamily);
  });

  it('keeps each lease inside pg-boss limits and each heartbeat window valid', () => {
    const nightly = [
      refreshRecommendationsFamily,
      refreshHoldFeaturesFamily,
      refreshClimbGradesFamily,
      refreshClimbNeighborsFamily,
      // Daily, and its Monday run must end before Tuesday's.
      communityMonthlyStatsFamily,
    ];
    const weekly = [
      refreshMoonboardAngleEstimatesFamily,
      refreshMoonboardWideAngleEstimatesFamily,
      sprayWallHealthFamily,
    ];
    for (const family of [...nightly, ...weekly]) {
      // pg-boss's own attempt-lease cap.
      expect(family.options.expireInSeconds).toBeLessThanOrEqual(24 * 60 * 60);
      expect(family.options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
      expect(family.options.heartbeatSeconds).toBeLessThan(family.options.expireInSeconds);
      expect(family.options.retryBackoff).toBe(true);
    }
    // A nightly run must give up before the next night's run is due.
    for (const family of nightly) expect(family.options.deadlineSeconds).toBeLessThan(24 * 60 * 60);
    // A weekly run gets six days, so it still ends before the next Monday.
    for (const family of weekly) expect(family.options.deadlineSeconds).toBeLessThanOrEqual(6 * 24 * 60 * 60);
    expect(refreshRecommendationsFamily.options).toMatchObject({
      expireInSeconds: 1200,
      retryLimit: 2,
      retryDelay: 300,
      deadlineSeconds: 72_000,
    });
    expect(refreshHoldFeaturesFamily.options).toMatchObject({
      expireInSeconds: 1200,
      retryLimit: 2,
      retryDelay: 300,
      deadlineSeconds: 72_000,
    });
    expect(refreshClimbGradesFamily.options).toMatchObject({
      expireInSeconds: 1800,
      retryLimit: 1,
      retryDelay: 900,
      deadlineSeconds: 72_000,
    });
    expect(refreshMoonboardAngleEstimatesFamily.options).toMatchObject({
      expireInSeconds: 1800,
      retryLimit: 1,
      retryDelay: 900,
      deadlineSeconds: 518_400,
      // One publish transaction, ~131 s measured on GitHub Actions.
      heartbeatSeconds: 600,
    });
    expect(refreshMoonboardWideAngleEstimatesFamily.options).toMatchObject({
      // The whole chunked run (~24 min measured) must end inside the lease.
      expireInSeconds: 7200,
      retryLimit: 1,
      retryDelay: 900,
      deadlineSeconds: 518_400,
      // Sized to one ~50k-row publish chunk, not the whole publish.
      heartbeatSeconds: 300,
    });
    expect(sprayWallHealthFamily.options).toMatchObject({
      // A read-only sweep of aggregate queries; a cold database is the worst case.
      expireInSeconds: 600,
      retryLimit: 1,
      retryDelay: 300,
      deadlineSeconds: 518_400,
      heartbeatSeconds: 300,
    });
    expect(communityMonthlyStatsFamily.options).toMatchObject({
      // Five read-only scans; the weekly 13-month run checks tick privacy per send.
      expireInSeconds: 900,
      retryLimit: 1,
      retryDelay: 300,
      deadlineSeconds: 72_000,
      heartbeatSeconds: 300,
    });
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

  it('schedules one nightly or weekly UTC job each, fanned out with the default payload', async () => {
    expect(refreshRecommendationsFamily.schedules?.map(({ key, cron, tz }) => ({ key, cron, tz }))).toEqual([
      { key: 'nightly', cron: '0 6 * * *', tz: undefined },
    ]);
    expect(refreshHoldFeaturesFamily.schedules?.map(({ cron }) => cron)).toEqual(['15 6 * * *']);
    expect(refreshClimbGradesFamily.schedules?.map(({ cron }) => cron)).toEqual(['30 6 * * *']);
    expect(refreshMoonboardAngleEstimatesFamily.schedules?.map(({ key, cron }) => ({ key, cron }))).toEqual([
      { key: 'weekly', cron: '0 8 * * 1' },
    ]);
    expect(refreshMoonboardWideAngleEstimatesFamily.schedules?.map(({ key, cron }) => ({ key, cron }))).toEqual([
      { key: 'weekly', cron: '30 8 * * 1' },
    ]);
    expect(sprayWallHealthFamily.schedules?.map(({ key, cron }) => ({ key, cron }))).toEqual([
      { key: 'weekly', cron: '45 8 * * 1' },
    ]);
    expect(await refreshRecommendationsFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: {} }]);
    expect(await refreshHoldFeaturesFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: { board: 'kilter' } }]);
    expect(await refreshClimbGradesFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: {} }]);
    expect(await refreshMoonboardAngleEstimatesFamily.schedules?.[0].fanOut(database)).toEqual([
      { payload: { publish: true } },
    ]);
    expect(await refreshMoonboardWideAngleEstimatesFamily.schedules?.[0].fanOut(database)).toEqual([
      { payload: { publish: true } },
    ]);
    expect(await sprayWallHealthFamily.schedules?.[0].fanOut(database)).toEqual([{ payload: { dryRun: false } }]);
  });

  it('re-sends the community recap daily for two months and every Monday for thirteen', async () => {
    expect(communityMonthlyStatsFamily.schedules?.map(({ key, cron, tz }) => ({ key, cron, tz }))).toEqual([
      { key: 'daily', cron: '30 7 * * 0,2-6', tz: undefined },
      { key: 'weekly', cron: '30 7 * * 1', tz: undefined },
    ]);
    const [daily, weekly] = communityMonthlyStatsFamily.schedules ?? [];
    expect(await daily.fanOut(database)).toEqual([{ payload: { months: 2, retireMonths: 0, dryRun: false } }]);
    // The Monday run also retires the names of the month just behind its window.
    expect(await weekly.fanOut(database)).toEqual([{ payload: { months: 13, retireMonths: 1, dryRun: false } }]);
    // Each slot's payload is one the worker accepts, under its own key.
    const keys: Array<string | undefined> = [];
    for (const schedule of [daily, weekly]) {
      const [request] = await schedule.fanOut(database);
      keys.push(communityMonthlyStatsFamily.singletonKey?.(communityMonthlyStatsFamily.payload.parse(request.payload)));
    }
    expect(keys).toEqual(['2', '13+1']);
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

  it('refresh-moonboard-angle-estimates defaults publish to true and keys on one weekly slot', () => {
    expect(refreshMoonboardAngleEstimatesFamily.payload.parse({})).toEqual({ publish: true });
    expect(refreshMoonboardAngleEstimatesFamily.payload.parse({ publish: false, validateOnly: true })).toEqual({
      publish: false,
      validateOnly: true,
    });
    expect(refreshMoonboardAngleEstimatesFamily.payload.safeParse({ board: 'kilter' }).success).toBe(false);
    expect(refreshMoonboardAngleEstimatesFamily.singletonKey?.({ publish: true })).toBe('weekly');
  });

  it('refresh-moonboard-wide-angle-estimates defaults publish to true and keys on one weekly slot', () => {
    expect(refreshMoonboardWideAngleEstimatesFamily.payload.parse({})).toEqual({ publish: true });
    expect(refreshMoonboardWideAngleEstimatesFamily.payload.parse({ publish: false, dryRun: true })).toEqual({
      publish: false,
      dryRun: true,
    });
    expect(refreshMoonboardWideAngleEstimatesFamily.payload.safeParse({ validateOnly: true }).success).toBe(false);
    expect(refreshMoonboardWideAngleEstimatesFamily.singletonKey?.({ publish: true })).toBe('weekly');
  });

  it('community-monthly-stats defaults to two months and keys by the window size', () => {
    expect(communityMonthlyStatsFamily.payload.parse({})).toEqual({ months: 2, retireMonths: 0, dryRun: false });
    expect(communityMonthlyStatsFamily.payload.parse({ months: 13, retireMonths: 3, dryRun: true })).toEqual({
      months: 13,
      retireMonths: 3,
      dryRun: true,
    });
    expect(communityMonthlyStatsFamily.payload.parse({ months: 1 })).toEqual({
      months: 1,
      retireMonths: 0,
      dryRun: false,
    });
    for (const months of [0, 14, 1.5, '2', -1]) {
      expect(communityMonthlyStatsFamily.payload.safeParse({ months }).success, String(months)).toBe(false);
    }
    for (const retireMonths of [-1, 13, 0.5]) {
      expect(
        communityMonthlyStatsFamily.payload.safeParse({ months: 13, retireMonths }).success,
        String(retireMonths),
      ).toBe(false);
    }
    // Retiring a month inside the window would strip names the weekly run puts back.
    expect(communityMonthlyStatsFamily.payload.safeParse({ months: 2, retireMonths: 1 }).success).toBe(false);
    expect(communityMonthlyStatsFamily.payload.safeParse({ months: 2, month: '2026-09' }).success).toBe(false);
    expect(communityMonthlyStatsFamily.payload.safeParse({ dryRun: 'yes' }).success).toBe(false);
  });

  it("community-monthly-stats keeps a dry run out of a real run's queue slot", () => {
    const key = (months: number, retireMonths: number, dryRun: boolean) =>
      communityMonthlyStatsFamily.singletonKey?.({ months, retireMonths, dryRun });
    expect(key(2, 0, false)).toBe('2');
    expect(key(2, 0, true)).toBe('2:dry-run');
    expect(key(13, 1, false)).toBe('13+1');
    expect(key(13, 1, true)).toBe('13+1:dry-run');
    expect(key(13, 0, false)).toBe('13');
    expect(
      new Set([key(2, 0, false), key(2, 0, true), key(13, 1, false), key(13, 1, true), key(13, 0, false)]).size,
    ).toBe(5);
  });

  it('spray-wall-health defaults to the live weekly slot and keys a backfill by its week', () => {
    expect(sprayWallHealthFamily.payload.parse({})).toEqual({ dryRun: false });
    expect(sprayWallHealthFamily.payload.parse({ weekStart: '2026-09-21', dryRun: true })).toEqual({
      weekStart: '2026-09-21',
      dryRun: true,
    });
    expect(sprayWallHealthFamily.payload.safeParse({ weekStart: 'last monday' }).success).toBe(false);
    expect(sprayWallHealthFamily.payload.safeParse({ publish: true }).success).toBe(false);
    expect(sprayWallHealthFamily.singletonKey?.({ dryRun: false })).toBe('weekly');
    // A `weekStart` backfill must not be swallowed by the weekly singleton.
    expect(sprayWallHealthFamily.singletonKey?.({ dryRun: false, weekStart: '2026-09-21' })).toBe('2026-09-21');
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

  it('refresh-moonboard-angle-estimates writes through the fence with the parsed payload', async () => {
    const { context: jobContext, transaction } = context('refresh-moonboard-angle-estimates');
    await refreshMoonboardAngleEstimatesFamily.execute(jobContext, { publish: true, validateOnly: false });
    const [options] = jobs.runMoonboardAngleEstimates.mock.calls[0];
    expect(options).toMatchObject({
      db: database,
      signal: jobContext.signal,
      publish: true,
      validateOnly: false,
      dryRun: false,
    });
    expect(await writeThrough(options)).toBe(fencedTransaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('refresh-moonboard-angle-estimates maps an unusable fit to a non-retryable FIT_UNUSABLE', async () => {
    jobs.runMoonboardAngleEstimates.mockRejectedValue(new MoonboardFitUnusableError(['no dual-angle sample']));
    const failure = await refreshMoonboardAngleEstimatesFamily
      .execute(context('refresh-moonboard-angle-estimates').context, { publish: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'FIT_UNUSABLE', retryable: false });
  });

  describe('spray-wall-health', () => {
    const metrics = {
      wallsLive: 7,
      wallsCreated: 2,
      wallsGym: 3,
      wallsPublic: 4,
      wallsActive: 5,
      wallsSecondClimber: 2,
      climbsLive: 41,
      climbsCreated: 9,
      climbsDegraded: 3,
      litEvents: 18,
      litWalls: 4,
      litClimbs: 12,
      ticksLogged: 25,
      ticksSends: 19,
      peopleActive: 6,
      ticksNonOwner: 8,
      resetsPublished: 1,
      reportsFiled: 2,
      holdsAlive: 460,
    };

    beforeEach(() => {
      capture.captureBackendEvent.mockReset().mockReturnValue(false);
      jobs.computeSprayWallHealth.mockResolvedValue({ weekStart: '2026-09-28', metrics });
    });

    it('measures the week and captures the aggregate as one personless event', async () => {
      const { context: jobContext } = context('spray-wall-health');
      await sprayWallHealthFamily.execute(jobContext, sprayWallHealthFamily.payload.parse({}));
      expect(jobs.computeSprayWallHealth).toHaveBeenCalledWith({
        db: database,
        signal: jobContext.signal,
        weekStart: undefined,
      });
      expect(capture.captureBackendEvent).toHaveBeenCalledTimes(1);
      const [eventName, options] = capture.captureBackendEvent.mock.calls[0] ?? [];
      expect(eventName).toBe('Spray Wall Health Weekly');
      expect(options).toMatchObject({
        systemDistinctId: 'system:spray-wall-health:2026-09-28',
      });
      expect(options?.properties).toMatchObject({ weekStart: '2026-09-28', wallsLive: 7, holdsAlive: 460 });
    });

    it('passes a backfill week through and refuses to emit on a dry run', async () => {
      await sprayWallHealthFamily.execute(context('spray-wall-health').context, {
        weekStart: '2026-09-21',
        dryRun: true,
      });
      expect(jobs.computeSprayWallHealth.mock.calls[0][0].weekStart).toBe('2026-09-21');
      expect(capture.captureBackendEvent).not.toHaveBeenCalled();
    });

    it('maps a bad weekStart to a non-retryable WEEK_START_INVALID', async () => {
      jobs.computeSprayWallHealth.mockRejectedValue(new SprayWallHealthInputError('weekStart must be a Monday'));
      const failure = await sprayWallHealthFamily
        .execute(context('spray-wall-health').context, { dryRun: false })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BackgroundJobError);
      expect(failure).toMatchObject({ code: 'WEEK_START_INVALID', retryable: false });
      expect(capture.captureBackendEvent).not.toHaveBeenCalled();
    });
  });

  describe('community-monthly-stats', () => {
    const september = {
      month: '2026-09',
      complete: true,
      summary: {
        climbersWhoLit: 4,
        climbsLit: 30,
        boardsLit: 2,
        gymsWithActivity: 1,
        sendsLogged: 12,
        climbersWhoLogged: 3,
        newAccounts: 2,
      },
      topGyms: [{ rank: 1, gymName: 'Alpha Gym', gymSlug: 'alpha-gym', climbers: 4, climbsLit: 30, boards: 2 }],
      topClimbers: [
        { rank: 1, climberName: 'Alice Secretname', sends: 7, flashes: 2, sendDays: 3 },
        { rank: 2, climberName: null, sends: 5, flashes: 0, sendDays: 2 },
      ],
      namesRetired: false,
    };
    const october = { ...september, month: '2026-10', complete: false };

    let infoSpy: ReturnType<typeof vi.spyOn>;
    const loggedLines = (): string[] => infoSpy.mock.calls.map((call: unknown[]) => String(call[0]));

    beforeEach(() => {
      capture.captureBackendEvent.mockReset().mockReturnValue(true);
      capture.flushBackendEvents.mockClear();
      infoSpy = vi.spyOn(logger, 'info');
      recap.computeCommunityMonthlyStats.mockReset().mockResolvedValue({
        months: [september, october],
        skippedMonths: [],
      });
    });

    afterEach(() => {
      infoSpy.mockRestore();
    });

    it('measures the window and sends 21 personless events per month', async () => {
      const { context: jobContext } = context('community-monthly-stats');
      await communityMonthlyStatsFamily.execute(jobContext, { months: 2, retireMonths: 0, dryRun: false });
      expect(recap.computeCommunityMonthlyStats).toHaveBeenCalledWith({
        database,
        now: expect.any(Date),
        months: 2,
        retireMonths: 0,
        signal: jobContext.signal,
      });
      const calls = capture.captureBackendEvent.mock.calls;
      expect(calls).toHaveLength(42);
      expect(calls.filter(([eventName]) => eventName === 'Community Monthly Summary')).toHaveLength(2);
      expect(calls.filter(([eventName]) => eventName === 'Community Monthly Rank')).toHaveLength(40);
      for (const [, options] of calls) {
        expect(options.systemDistinctId).toBe('system:community-monthly');
        expect(options.uuid).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(calls[0][1]).toMatchObject({
        timestamp: new Date('2026-09-01T12:00:00.000Z'),
        properties: { month: '2026-09', complete: true, climbsLit: 30 },
      });
      expect(capture.flushBackendEvents).toHaveBeenCalledTimes(1);
      expect(loggedLines().at(-1)).toBe('community-monthly-stats emitted 42 of 42 events for 2 months');
    });

    it('succeeds with analytics disabled', async () => {
      capture.captureBackendEvent.mockReturnValue(false);
      await expect(
        communityMonthlyStatsFamily.execute(context('community-monthly-stats').context, {
          months: 13,
          retireMonths: 1,
          dryRun: false,
        }),
      ).resolves.toBeUndefined();
      expect(loggedLines().at(-1)).toContain('analytics disabled, nothing emitted');
      expect(capture.flushBackendEvents).not.toHaveBeenCalled();
    });

    it('emits nothing on a dry run and never logs a climber name', async () => {
      await communityMonthlyStatsFamily.execute(context('community-monthly-stats').context, {
        months: 2,
        retireMonths: 0,
        dryRun: true,
      });
      expect(capture.captureBackendEvent).not.toHaveBeenCalled();
      expect(capture.flushBackendEvents).not.toHaveBeenCalled();
      const logged = loggedLines().join('\n');
      expect(logged).toContain('1. <named> (7 sends, 2 flashes, 3 days)');
      expect(logged).toContain('2. <anonymous> (5 sends, 0 flashes, 2 days)');
      expect(logged).toContain('Alpha Gym');
      expect(logged).toContain('2026-10 (partial)');
      expect(logged).not.toContain('Secretname');
    });

    it('clears the rank rows of a month with no lighting and sends it no summary', async () => {
      recap.computeCommunityMonthlyStats.mockResolvedValue({
        months: [september],
        skippedMonths: [{ month: '2026-10', complete: false }],
      });
      await communityMonthlyStatsFamily.execute(context('community-monthly-stats').context, {
        months: 2,
        retireMonths: 0,
        dryRun: false,
      });
      const october = capture.captureBackendEvent.mock.calls.filter(
        ([, options]) => options.properties?.month === '2026-10',
      );
      expect(october).toHaveLength(20);
      for (const [eventName, options] of october) {
        expect(eventName).toBe('Community Monthly Rank');
        expect(options.properties).toMatchObject({ empty: true, complete: false });
      }
      expect(capture.captureBackendEvent).toHaveBeenCalledTimes(41);
      expect(loggedLines().at(-1)).toBe(
        'community-monthly-stats emitted 41 of 41 events for 1 months; no lit climbs, rank rows cleared: 2026-10',
      );
    });

    it('sends a retired month like any other, under the same uuids, with the names the compute removed', async () => {
      const retired = {
        ...september,
        month: '2025-09',
        namesRetired: true,
        topClimbers: september.topClimbers.map((climber) => ({ ...climber, climberName: null })),
      };
      recap.computeCommunityMonthlyStats.mockResolvedValue({ months: [retired, september], skippedMonths: [] });
      const { context: jobContext } = context('community-monthly-stats');
      await communityMonthlyStatsFamily.execute(jobContext, { months: 13, retireMonths: 1, dryRun: false });
      expect(recap.computeCommunityMonthlyStats.mock.calls[0][0]).toMatchObject({ months: 13, retireMonths: 1 });
      const retiredClimbers = capture.captureBackendEvent.mock.calls
        .map(([, options]) => options.properties ?? {})
        .filter((properties) => properties.month === '2025-09' && properties.list === 'climbers');
      expect(retiredClimbers).toHaveLength(10);
      for (const properties of retiredClimbers) expect(properties.climberName).toBeNull();
      expect(retiredClimbers[0]).toMatchObject({ rank: 1, empty: false, named: false, sends: 7 });
    });
  });

  it('refresh-moonboard-angle-estimates lets any other failure retry', async () => {
    const outage = new Error('connection reset');
    jobs.runMoonboardAngleEstimates.mockRejectedValue(outage);
    await expect(
      refreshMoonboardAngleEstimatesFamily.execute(context('refresh-moonboard-angle-estimates').context, {
        publish: true,
      }),
    ).rejects.toBe(outage);
  });

  it('refresh-moonboard-wide-angle-estimates writes through the fence with the parsed payload', async () => {
    const { context: jobContext, transaction } = context('refresh-moonboard-wide-angle-estimates');
    await refreshMoonboardWideAngleEstimatesFamily.execute(jobContext, { publish: true, dryRun: false });
    const [options] = jobs.runMoonboardWideAngleEstimates.mock.calls[0];
    expect(options).toMatchObject({ db: database, signal: jobContext.signal, publish: true, dryRun: false });
    expect(await writeThrough(options)).toBe(fencedTransaction);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('both MoonBoard families let dryRun win over a defaulted publish', async () => {
    await refreshMoonboardAngleEstimatesFamily.execute(
      context('refresh-moonboard-angle-estimates').context,
      refreshMoonboardAngleEstimatesFamily.payload.parse({ dryRun: true }),
    );
    expect(jobs.runMoonboardAngleEstimates.mock.calls[0][0]).toMatchObject({ publish: false, dryRun: true });
    await refreshMoonboardWideAngleEstimatesFamily.execute(
      context('refresh-moonboard-wide-angle-estimates').context,
      refreshMoonboardWideAngleEstimatesFamily.payload.parse({ dryRun: true }),
    );
    expect(jobs.runMoonboardWideAngleEstimates.mock.calls[0][0]).toMatchObject({ publish: false, dryRun: true });
  });

  it('refresh-moonboard-wide-angle-estimates maps an unusable fit to a non-retryable FIT_UNUSABLE', async () => {
    jobs.runMoonboardWideAngleEstimates.mockRejectedValue(
      new MoonboardFitUnusableError(['no angle-surface coverage from any shape board']),
    );
    const failure = await refreshMoonboardWideAngleEstimatesFamily
      .execute(context('refresh-moonboard-wide-angle-estimates').context, { publish: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'FIT_UNUSABLE', retryable: false });
  });

  it('refresh-moonboard-wide-angle-estimates lets any other failure retry', async () => {
    const outage = new Error('connection reset');
    jobs.runMoonboardWideAngleEstimates.mockRejectedValue(outage);
    await expect(
      refreshMoonboardWideAngleEstimatesFamily.execute(context('refresh-moonboard-wide-angle-estimates').context, {
        publish: true,
      }),
    ).rejects.toBe(outage);
  });
});
