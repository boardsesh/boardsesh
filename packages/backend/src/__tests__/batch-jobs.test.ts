/**
 * The three batch families end to end against the test Postgres, on the short
 * fixture in helpers/batch-job-fixture.ts: what each job writes, that every
 * write goes through the context's transaction, and how a grade gate failure
 * ends the run. The same jobs under the restricted batch login are proven in
 * services/__tests__/job-queue-roles.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray, like } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { runRefreshClimbGrades, type JobDatabase, type JobTransact } from '@boardsesh/db/jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { db } from '../db/client';
import { BackgroundJobError, type BackgroundJobContext } from '../workers/families';
import { refreshClimbGradesFamily } from '../workers/families/refresh-climb-grades';
import { refreshHoldFeaturesFamily } from '../workers/families/refresh-hold-features';
import { refreshRecommendationsFamily } from '../workers/families/refresh-recommendations';
import {
  FIXTURE_PREFIX,
  KILTER_CLIMBS,
  MOONBOARD_CLIMB,
  clearBatchJobFixture,
  posthogSendRows,
  seedBatchJobFixture,
} from './helpers/batch-job-fixture';

// The Tension benchmark holdout gates need at least 100 hashed-out benchmark
// rows and a calibrated interval coverage; a three-climb fixture cannot pass
// them honestly. Pass them here so the publish path runs. Every other gate,
// including the backtest that blocks the family run below, is real.
vi.mock('../../../db/src/queries/grade-model/index.ts', async (importOriginal) => {
  // Untyped on purpose: a typed `import()` of a path outside this package's
  // rootDir would pull the file into the backend's tsc program.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    evaluateTensionBenchmarkHoldout: () =>
      ['deherded_tension_benchmark', 'deherded_tension_calibration', 'deherded_segment_no_regression'].map((gate) => ({
        gate,
        passed: true,
        detail: 'stubbed for the fixture',
        metrics: {},
      })),
  };
});

const silentLog = { info: () => {}, warn: () => {} };

/** A context whose fence is a plain transaction, counting the write batches it runs. */
function contextFor(database: DbInstance, family: BackgroundJobContext['family']) {
  const transactions = { calls: 0 };
  const context: BackgroundJobContext = {
    runId: randomUUID(),
    family,
    signal: new AbortController().signal,
    database,
    transaction: (callback) => {
      transactions.calls += 1;
      return database.transaction(callback);
    },
  };
  return { context, transactions };
}

describe('batch families on the test database', () => {
  beforeAll(async () => {
    await clearBatchJobFixture(db);
    await seedBatchJobFixture(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await clearBatchJobFixture(db);
  });

  it('refresh-recommendations rebuilds stats, playlists and the weekly history through the fence', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ results: posthogSendRows() }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'test-personal-key');
    vi.stubEnv('POSTHOG_PROJECT_ID', '');
    vi.stubEnv('POSTHOG_HOST', '');
    const { context, transactions } = contextFor(db, 'refresh-recommendations');

    await refreshRecommendationsFamily.execute(context, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://us.posthog.com/api/projects/412845/query/');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-personal-key');
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const setters = await db
      .select()
      .from(dbSchema.boardSetterStats)
      .where(like(dbSchema.boardSetterStats.setterUsername, 'fixture-setter-%'))
      .orderBy(dbSchema.boardSetterStats.setterUsername);
    expect(setters.map((row) => [row.setterUsername, row.climbCount])).toEqual([
      ['fixture-setter-a', 2],
      ['fixture-setter-b', 4],
    ]);
    const sends = await db
      .select()
      .from(dbSchema.boardClimbSendStats)
      .where(like(dbSchema.boardClimbSendStats.climbUuid, `${FIXTURE_PREFIX}%`));
    expect(sends).toMatchObject([{ boardType: 'kilter', climbUuid: KILTER_CLIMBS[0], sendCount30d: 3 }]);

    const [crowd] = await db
      .select()
      .from(dbSchema.playlists)
      .where(eq(dbSchema.playlists.generatedRecommendation, 'kilter:8:17:40:crowd-favorites'));
    const crowdClimbs = await db
      .select({ climbUuid: dbSchema.playlistClimbs.climbUuid })
      .from(dbSchema.playlistClimbs)
      .where(eq(dbSchema.playlistClimbs.playlistId, crowd.id));
    expect(crowdClimbs.map((row) => row.climbUuid).sort()).toEqual([...KILTER_CLIMBS].sort());

    const history = await db
      .select()
      .from(dbSchema.boardClimbStatsHistory)
      .where(eq(dbSchema.boardClimbStatsHistory.climbUuid, MOONBOARD_CLIMB));
    expect(history).toHaveLength(1);

    // Every write batch went through the context's transaction: the system
    // user, setter stats, send stats, three playlists and three history boards.
    expect(transactions.calls).toBe(9);

    // A second night replaces each playlist's climbs; the history is not due.
    await refreshRecommendationsFamily.execute(contextFor(db, 'refresh-recommendations').context, {});
    expect(
      await db
        .select()
        .from(dbSchema.boardClimbStatsHistory)
        .where(eq(dbSchema.boardClimbStatsHistory.climbUuid, MOONBOARD_CLIMB)),
    ).toHaveLength(1);
    const deletions = await db
      .select()
      .from(dbSchema.syncDeletions)
      .where(
        and(
          eq(dbSchema.syncDeletions.tableName, 'playlist_climbs'),
          eq(dbSchema.syncDeletions.userId, 'system-recommendations'),
        ),
      );
    expect(deletions.length).toBeGreaterThan(0);
  });

  it('refresh-recommendations skips the send stats with a warning when the key is unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
    await refreshRecommendationsFamily.execute(contextFor(db, 'refresh-recommendations').context, {});
    expect(fetchMock).not.toHaveBeenCalled();
    // The previous rebuild is left in place.
    expect(
      await db
        .select()
        .from(dbSchema.boardClimbSendStats)
        .where(eq(dbSchema.boardClimbSendStats.climbUuid, KILTER_CLIMBS[0])),
    ).toHaveLength(1);
  });

  it('refresh-hold-features writes nothing on a dry run and one batch per layout otherwise', async () => {
    const dry = contextFor(db, 'refresh-hold-features');
    await refreshHoldFeaturesFamily.execute(dry.context, refreshHoldFeaturesFamily.payload.parse({ dryRun: true }));
    expect(dry.transactions.calls).toBe(0);
    expect(await db.select().from(dbSchema.boardHoldFeatures)).toHaveLength(0);

    const live = contextFor(db, 'refresh-hold-features');
    await refreshHoldFeaturesFamily.execute(live.context, refreshHoldFeaturesFamily.payload.parse({}));
    // The system user, then layout 8.
    expect(live.transactions.calls).toBe(2);
    const features = await db
      .select()
      .from(dbSchema.boardHoldFeatures)
      .where(eq(dbSchema.boardHoldFeatures.boardType, 'kilter'));
    expect(features).toHaveLength(6);
    expect(features.every((row) => row.layoutId === 8 && row.featureVersion === 'v1')).toBe(true);
    const shadow = await db
      .select()
      .from(dbSchema.userHoldClassifications)
      .where(eq(dbSchema.userHoldClassifications.userId, 'system-hold-classifier'));
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow.every((row) => row.sizeId === 17 && row.layoutId === 8)).toBe(true);
  });

  it('refresh-climb-grades fails GATES_FAILED without writing when the backtest has no sample', async () => {
    const { context, transactions } = contextFor(db, 'refresh-climb-grades');
    const failure = await refreshClimbGradesFamily.execute(context, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'GATES_FAILED', retryable: false });
    expect(transactions.calls).toBe(0);
    expect(await db.select().from(dbSchema.boardGradeCoefficients)).toHaveLength(0);
  });

  it('refresh-climb-grades publishes coefficients, gates and grades in one batch', async () => {
    const database: JobDatabase = db;
    const transacts = { calls: 0 };
    const transact: JobTransact = (callback) => {
      transacts.calls += 1;
      return database.transaction((transaction) => callback(transaction));
    };
    const result = await runRefreshClimbGrades({
      db: database,
      signal: new AbortController().signal,
      transact,
      log: silentLog,
      refit: false,
      dryRun: false,
      validateOnly: false,
      allowEmptyBacktest: true,
      publishCrossAngleEstimates: false,
    });
    expect(result.mode).toBe('published');
    // The publish, then the honesty report.
    expect(transacts.calls).toBe(2);
    const grades = await db
      .select()
      .from(dbSchema.boardClimbGrades)
      .where(inArray(dbSchema.boardClimbGrades.climbUuid, KILTER_CLIMBS));
    expect(grades).toHaveLength(KILTER_CLIMBS.length);
    const gateRuns = await db
      .select()
      .from(dbSchema.boardGradeCoefficients)
      .where(eq(dbSchema.boardGradeCoefficients.kind, 'gate_results'));
    expect(gateRuns).toHaveLength(1);
  });
});
