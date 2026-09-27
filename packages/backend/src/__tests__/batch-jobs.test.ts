/**
 * The batch families end to end against the test Postgres, on the short
 * fixture in helpers/batch-job-fixture.ts: what each job writes, that every
 * write goes through the context's transaction, how a grade gate failure ends
 * the run, and how a neighbours run stopped by its signal resumes. The same jobs under the restricted batch login are proven in
 * services/__tests__/job-queue-roles.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  ClimbNeighborsInterruptedError,
  runRefreshClimbGrades,
  runRefreshClimbNeighbors,
  type JobDatabase,
  type JobTransact,
} from '@boardsesh/db/jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { db } from '../db/client';
import { BackgroundJobError, type BackgroundJobContext } from '../workers/families';
import { refreshClimbGradesFamily } from '../workers/families/refresh-climb-grades';
import { refreshClimbNeighborsFamily } from '../workers/families/refresh-climb-neighbors';
import { refreshHoldFeaturesFamily } from '../workers/families/refresh-hold-features';
import { refreshRecommendationsFamily } from '../workers/families/refresh-recommendations';
import {
  FIXTURE_PREFIX,
  KILTER_CLIMBS,
  MOONBOARD_CLIMB,
  NEIGHBOR_BOARD,
  NEIGHBOR_LARGE_CLIMBS,
  NEIGHBOR_LARGE_LAYOUT,
  NEIGHBOR_SMALL_CLIMBS,
  NEIGHBOR_SMALL_LAYOUT,
  clearBatchJobFixture,
  clearClimbNeighborState,
  insertNeighborClimb,
  posthogSendRows,
  seedBatchJobFixture,
  seedClimbNeighborFixture,
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

/**
 * A context whose fence is a plain transaction, counting the write batches it
 * runs. Like the worker's fence it refuses to start, or to return from, a
 * batch once the signal has fired (an AbortError). `afterTransaction` runs
 * after each batch has returned, so a test can stop the run between batches.
 */
function contextFor(
  database: DbInstance,
  family: BackgroundJobContext['family'],
  {
    signal = new AbortController().signal,
    afterTransaction,
  }: { signal?: AbortSignal; afterTransaction?: () => Promise<void> } = {},
) {
  const transactions = { calls: 0 };
  const context: BackgroundJobContext = {
    runId: randomUUID(),
    family,
    signal,
    database,
    transaction: async (callback) => {
      transactions.calls += 1;
      signal.throwIfAborted();
      const result = await database.transaction(callback);
      signal.throwIfAborted();
      await afterTransaction?.();
      return result;
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
    const coefficientsBefore = await db.$count(dbSchema.boardGradeCoefficients);
    const { context, transactions } = contextFor(db, 'refresh-climb-grades');
    const failure = await refreshClimbGradesFamily.execute(context, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'GATES_FAILED', retryable: false });
    expect(transactions.calls).toBe(0);
    expect(await db.$count(dbSchema.boardGradeCoefficients)).toBe(coefficientsBefore);
  });

  it('refresh-climb-grades publishes coefficients, gates and grades in one batch', async () => {
    const database: JobDatabase = db;
    const gateRunsBefore = await db.$count(
      dbSchema.boardGradeCoefficients,
      eq(dbSchema.boardGradeCoefficients.kind, 'gate_results'),
    );
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
    // The publish is the only fenced batch; the honesty report is a plain read.
    expect(transacts.calls).toBe(1);
    const grades = await db
      .select()
      .from(dbSchema.boardClimbGrades)
      .where(inArray(dbSchema.boardClimbGrades.climbUuid, KILTER_CLIMBS));
    expect(grades).toHaveLength(KILTER_CLIMBS.length);
    expect(
      await db.$count(dbSchema.boardGradeCoefficients, eq(dbSchema.boardGradeCoefficients.kind, 'gate_results')),
    ).toBe(gateRunsBefore + 1);
  });
});

describe('refresh-climb-neighbors on the test database', () => {
  const lateClimb = `${FIXTURE_PREFIX}nb-late`;

  async function listOf(uuid: string): Promise<string[]> {
    const rows = await db
      .select({ neighbor: dbSchema.boardClimbNeighbors.neighborUuid })
      .from(dbSchema.boardClimbNeighbors)
      .where(eq(dbSchema.boardClimbNeighbors.climbUuid, uuid))
      .orderBy(dbSchema.boardClimbNeighbors.rank);
    return rows.map(({ neighbor }) => neighbor);
  }

  async function runRow() {
    const [row] = await db
      .select()
      .from(dbSchema.boardClimbNeighborRuns)
      .where(eq(dbSchema.boardClimbNeighborRuns.boardType, NEIGHBOR_BOARD));
    return row;
  }

  async function finishedLayouts(): Promise<number[]> {
    const rows = await db
      .select({ layoutId: dbSchema.boardClimbNeighborGroupRuns.layoutId })
      .from(dbSchema.boardClimbNeighborGroupRuns)
      .where(eq(dbSchema.boardClimbNeighborGroupRuns.boardType, NEIGHBOR_BOARD));
    return rows.map(({ layoutId }) => layoutId).sort((left, right) => left - right);
  }

  async function highestSyncSeq(): Promise<number> {
    const [row] = await db
      .select({ seq: sql<string>`MAX(${dbSchema.boardClimbs.syncSeq})::text` })
      .from(dbSchema.boardClimbs)
      .where(eq(dbSchema.boardClimbs.boardType, NEIGHBOR_BOARD));
    return Number(row?.seq ?? 0);
  }

  beforeAll(async () => {
    await clearBatchJobFixture(db);
    await seedClimbNeighborFixture(db);
  });

  afterAll(async () => {
    await clearBatchJobFixture(db);
  });

  it('writes nothing on a dry run', async () => {
    const { context, transactions } = contextFor(db, 'refresh-climb-neighbors');
    await refreshClimbNeighborsFamily.execute(context, { board: NEIGHBOR_BOARD, dryRun: true });
    expect(transactions.calls).toBe(0);
    expect(await listOf(NEIGHBOR_LARGE_CLIMBS[0])).toEqual([]);
    expect(await runRow()).toBeUndefined();
  });

  it('builds a new board in full, every write through the transaction, then folds a new climb in', async () => {
    const database: JobDatabase = db;
    const transacts = { calls: 0 };
    const transact: JobTransact = (callback) => {
      transacts.calls += 1;
      return database.transaction((transaction) => callback(transaction));
    };
    const result = await runRefreshClimbNeighbors({
      db: database,
      signal: new AbortController().signal,
      transact,
      log: silentLog,
      boards: [NEIGHBOR_BOARD],
      full: false,
      dryRun: false,
      refillGaps: false,
    });
    const [board] = result.boards;
    // No watermark row yet, so the first run is a full build.
    expect(board).toMatchObject({ boardType: NEIGHBOR_BOARD, full: true, interrupted: false });
    // The build-state row, one chunk and one finished-group row per group, then
    // the sweep with the watermark.
    expect(transacts.calls).toBe(2 + 2 * board.groups.length);
    expect(await listOf(NEIGHBOR_SMALL_CLIMBS[0])).toEqual([NEIGHBOR_SMALL_CLIMBS[1]]);
    for (const uuid of NEIGHBOR_LARGE_CLIMBS) {
      expect([...(await listOf(uuid))].sort()).toEqual(NEIGHBOR_LARGE_CLIMBS.filter((other) => other !== uuid).sort());
    }
    const built = await runRow();
    expect(built.lastSyncSeq).toBe(await highestSyncSeq());
    expect(built.fullBuildStartedAt).toBeNull();

    // The next night, through the family: one new climb on the large layout.
    await insertNeighborClimb(db, {
      uuid: lateClimb,
      layoutId: NEIGHBOR_LARGE_LAYOUT,
      holds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40],
    });
    const { context, transactions } = contextFor(db, 'refresh-climb-neighbors');
    await refreshClimbNeighborsFamily.execute(context, { board: NEIGHBOR_BOARD, refillGaps: false });
    // The work-set delete, the one chunk of touched lists, the watermark.
    expect(transactions.calls).toBe(3);
    expect(await listOf(lateClimb)).toHaveLength(NEIGHBOR_LARGE_CLIMBS.length);
    expect(await listOf(NEIGHBOR_LARGE_CLIMBS[0])).toContain(lateClimb);
    // The new climb has not settled, so the watermark stays for the next run to rescore it.
    expect((await runRow()).lastSyncSeq).toBe(built.lastSyncSeq);
  });

  it('a run stopped by its signal between batches fails INTERRUPTED, and the retry resumes the build', async () => {
    await db.delete(dbSchema.boardClimbs).where(eq(dbSchema.boardClimbs.uuid, lateClimb));
    await clearClimbNeighborState(db);

    // Abort once the small layout's group is recorded, as a shutdown would.
    const controller = new AbortController();
    const { context: stopped } = contextFor(db, 'refresh-climb-neighbors', {
      signal: controller.signal,
      afterTransaction: async () => {
        if ((await finishedLayouts()).includes(NEIGHBOR_SMALL_LAYOUT)) controller.abort();
      },
    });
    const failure = await refreshClimbNeighborsFamily
      .execute(stopped, { board: NEIGHBOR_BOARD, full: true, refillGaps: false })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'INTERRUPTED', retryable: true });
    expect(await finishedLayouts()).toEqual([NEIGHBOR_SMALL_LAYOUT]);
    expect(await listOf(NEIGHBOR_SMALL_CLIMBS[0])).toEqual([NEIGHBOR_SMALL_CLIMBS[1]]);
    expect(await listOf(NEIGHBOR_LARGE_CLIMBS[0])).toEqual([]);
    const cutOff = await runRow();
    expect(cutOff.lastSyncSeq).toBe(0);
    expect(cutOff.fullBuildStartedAt).not.toBeNull();

    // The retry is the same payload; the build state makes it resume, not restart.
    const { context } = contextFor(db, 'refresh-climb-neighbors');
    await refreshClimbNeighborsFamily.execute(context, { board: NEIGHBOR_BOARD, full: true, refillGaps: false });
    expect(await finishedLayouts()).toEqual([NEIGHBOR_SMALL_LAYOUT, NEIGHBOR_LARGE_LAYOUT].sort((a, b) => a - b));
    expect(await listOf(NEIGHBOR_LARGE_CLIMBS[0])).toHaveLength(NEIGHBOR_LARGE_CLIMBS.length - 1);
    const resumed = await runRow();
    expect(resumed.lastSyncSeq).toBe(cutOff.fullBuildSyncSeq);
    expect(resumed.fullBuildStartedAt).toBeNull();
  });

  it('the job body throws ClimbNeighborsInterruptedError when stopped between chunks', async () => {
    await clearClimbNeighborState(db);
    const controller = new AbortController();
    const failure = await runRefreshClimbNeighbors({
      db,
      signal: controller.signal,
      log: {
        info: (line) => {
          if (line.includes(`layout ${NEIGHBOR_SMALL_LAYOUT}:`) && line.includes('processed')) controller.abort();
        },
        warn: () => {},
      },
      boards: [NEIGHBOR_BOARD],
      full: true,
      dryRun: false,
      refillGaps: false,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClimbNeighborsInterruptedError);
    expect(failure).toMatchObject({ boardType: NEIGHBOR_BOARD });
    expect(await finishedLayouts()).toEqual([NEIGHBOR_SMALL_LAYOUT]);
  });

  it('a family run whose fenced batch aborts fails INTERRUPTED, not ATTEMPT_FAILED', async () => {
    await clearClimbNeighborState(db);
    const aborted = new AbortController();
    aborted.abort();
    // The first write (the build-state row) meets the fence's AbortError.
    const { context, transactions } = contextFor(db, 'refresh-climb-neighbors', { signal: aborted.signal });
    const failure = await refreshClimbNeighborsFamily
      .execute(context, { board: NEIGHBOR_BOARD, refillGaps: false })
      .catch((error: unknown) => error);
    expect(transactions.calls).toBe(1);
    expect(failure).toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ code: 'INTERRUPTED', retryable: true });
    expect(await runRow()).toBeUndefined();
  });
});
