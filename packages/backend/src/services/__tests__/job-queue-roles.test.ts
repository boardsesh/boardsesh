process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbInstance } from '@boardsesh/db/client';
import { runRefreshClimbGrades, runRefreshClimbNeighbors, type JobDatabase } from '@boardsesh/db/jobs';
import {
  CLIMB_POPULARITY_REFRESH_QUEUE,
  initializeJobQueueSchema,
  parseWorkerLogin,
  POPULAR_BOARD_CONFIGS_REFRESH_QUEUE,
} from '@boardsesh/db/job-queue-schema';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { createDb, type DbInstance } from '@boardsesh/db/client';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import { retrySprayDetectionAttempt } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { SPRAY_DETECTION_QUEUE, SPRAY_DETECTION_RECONCILE_QUEUE } from '@boardsesh/shared-schema';
import type { BackgroundJobContext } from '../../workers/families';
import { refreshClimbGradesFamily } from '../../workers/families/refresh-climb-grades';
import { refreshClimbNeighborsFamily } from '../../workers/families/refresh-climb-neighbors';
import { refreshHoldFeaturesFamily } from '../../workers/families/refresh-hold-features';
import { refreshMoonboardAngleEstimatesFamily } from '../../workers/families/refresh-moonboard-angle-estimates';
import { refreshMoonboardWideAngleEstimatesFamily } from '../../workers/families/refresh-moonboard-wide-angle-estimates';
import { refreshRecommendationsFamily } from '../../workers/families/refresh-recommendations';
import {
  FIXTURE_PREFIX,
  KILTER_CLIMBS,
  MOONBOARD_CLIMB,
  MOONBOARD_STALE_WIDE_CLIMB,
  MOONBOARD_WIDE_LADDER_ANGLES,
  NEIGHBOR_BOARD,
  NEIGHBOR_LARGE_CLIMBS,
  NEIGHBOR_LARGE_LAYOUT,
  clearBatchJobFixture,
  insertNeighborClimb,
  posthogSendRows,
  seedBatchJobFixture,
  seedClimbNeighborFixture,
  seedWideAngleShapeFixture,
} from '../../__tests__/helpers/batch-job-fixture';

// The Tension benchmark holdout gates need 100+ hashed-out benchmark rows; the
// fixture has none. Pass them so the grade publish runs under the batch login.
vi.mock('../../../../db/src/queries/grade-model/index.ts', async (importOriginal) => {
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

describe('owner-only queue initialization', () => {
  it('allows runtime scheduling and worker DML without schema CREATE', async () => {
    const role = `detector_test_${randomUUID().replaceAll('-', '')}`;
    const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.searchParams.set('options', `-c role=${role}`);
    const restricted = postgres(workerUrl.toString(), { max: 1 });
    const runtime = new PgBoss({
      connectionString: workerUrl.toString(),
      max: 1,
      migrate: false,
      supervise: false,
      schedule: true,
    });
    runtime.on('error', () => {});
    const [originalTypeAcl] = await owner`
      SELECT EXISTS (
        SELECT 1 FROM pg_type
        CROSS JOIN LATERAL aclexplode(COALESCE(typacl, acldefault('T', typowner))) AS privilege
        WHERE oid = 'public.spray_detection_status'::regtype
          AND privilege.grantee = 0 AND privilege.privilege_type = 'USAGE'
      ) AS public_usage`;
    try {
      await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
      // Production's ACL reconciler removes the default PUBLIC type grant.
      await owner`REVOKE ALL ON TYPE public.spray_detection_status FROM PUBLIC`;
      await initializeJobQueueSchema(drizzle(owner), undefined, role);
      const [typeGrant] =
        await restricted`SELECT has_type_privilege(current_user, 'public.spray_detection_status', 'USAGE') AS permitted`;
      expect(typeGrant.permitted).toBe(true);
      await expect(restricted`CREATE TABLE public.detector_forbidden (id int)`).rejects.toThrow('permission denied');
      await expect(restricted`CREATE TABLE pgboss.detector_forbidden (id int)`).rejects.toThrow('permission denied');
      await runtime.start();
      await runtime.schedule(SPRAY_DETECTION_RECONCILE_QUEUE, '* * * * *');
      // The popular-configs refresh: created by the owner, scheduled and
      // requested by the runtime role.
      await runtime.schedule(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, '17 4 * * *', null, { tz: 'UTC' });
      const refreshId = await runtime.send(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {});
      expect(refreshId).toBeTruthy();
      // `exclusive`: a second request while one is queued is dropped.
      expect(await runtime.send(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {})).toBeNull();
      // The climb-popularity refresh: the same contract, hourly.
      await runtime.schedule(CLIMB_POPULARITY_REFRESH_QUEUE, '23 * * * *', null, { tz: 'UTC' });
      expect(await runtime.send(CLIMB_POPULARITY_REFRESH_QUEUE, {})).toBeTruthy();
      expect(await runtime.send(CLIMB_POPULARITY_REFRESH_QUEUE, {})).toBeNull();
      const id = await runtime.send(SPRAY_DETECTION_QUEUE, { detectionId: randomUUID() });
      expect(id).toBeTruthy();
      const jobs = await runtime.fetch(SPRAY_DETECTION_QUEUE);
      expect(jobs).toHaveLength(1);
      await runtime.complete(SPRAY_DETECTION_QUEUE, jobs[0].id);
      expect((await runtime.getJobById(SPRAY_DETECTION_QUEUE, jobs[0].id))?.state).toBe('completed');
      const permitted = await restricted`SELECT id FROM spray_wall_detections LIMIT 1`;
      expect(Array.isArray(permitted)).toBe(true);
      // Exercise the worker UPDATE query's table permissions without changing a row.
      await retrySprayDetectionAttempt(drizzle(restricted), randomUUID(), randomUUID());
    } finally {
      if (originalTypeAcl.public_usage) await owner`GRANT USAGE ON TYPE public.spray_detection_status TO PUBLIC`;
      await runtime.stop({ graceful: true, close: true });
      await restricted.end();
      // This random NOLOGIN test role owns no objects, only grants in this
      // isolated worker database. Revoke them before removing the test role.
      await owner.unsafe(`DROP OWNED BY "${role}"`);
      await owner.unsafe(`DROP ROLE "${role}"`);
      await owner.end();
    }
  }, 30_000);
});

describe('worker login entries', () => {
  it('maps a role-prefixed entry to that role and keeps bare logins ledger-only', () => {
    expect(parseWorkerLogin('batch=boardsesh_worker_batch')).toEqual({
      login: 'boardsesh_worker_batch',
      role: 'batch',
    });
    expect(parseWorkerLogin('boardsesh_worker_batch')).toEqual({ login: 'boardsesh_worker_batch' });
    expect(() => parseWorkerLogin('warehouse=boardsesh_worker_batch')).toThrow('Invalid worker role');
    expect(() => parseWorkerLogin('batch=robert"; DROP')).toThrow('Invalid job queue role');
  });
});

/**
 * The batch login's grant list, proven: every batch family runs under a role
 * that holds only what `WORKER_ROLE_DATA_GRANTS.batch` grants. A missing grant
 * fails here with "permission denied", including the ones only a trigger or a
 * second night's replace path needs.
 */
describe('batch worker grants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('runs every batch family under the batch login and nothing more', async () => {
    const role = `batch_test_${randomUUID().replaceAll('-', '')}`;
    const owner = postgres(process.env.DATABASE_URL!, { max: 1 });
    const ownerDatabase: JobDatabase = drizzle(owner);
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.searchParams.set('options', `-c role=${role}`);
    // The worker's budget: two connections.
    const restricted = postgres(workerUrl.toString(), { max: 2 });
    // Families only use the database as a drizzle handle; the backend's
    // DbInstance is a singleton bound to the owner URL.
    const database = drizzle(restricted, { schema: dbSchema }) as unknown as DbInstance;
    const context = (family: BackgroundJobContext['family']): BackgroundJobContext => ({
      runId: randomUUID(),
      family,
      signal: new AbortController().signal,
      database,
      transaction: (callback) => database.transaction(callback),
    });
    try {
      // Test-worker databases are built from schema-sql.ts, which has no ledger.
      const [ledger] = await owner`SELECT to_regclass('public.background_job_runs') AS present`;
      if (!ledger.present) {
        for (const migration of ['0241_background_job_runs.sql', '0243_background_job_families.sql']) {
          await owner.unsafe(readFileSync(new URL(`../../../../db/drizzle/${migration}`, import.meta.url), 'utf8'));
        }
      }
      await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
      // Rebuilding a login's grants must never touch the backend's own login.
      await expect(initializeJobQueueSchema(drizzle(owner), role, undefined, [`batch=${role}`])).rejects.toThrow(
        'must not be the runtime or detector role',
      );
      await initializeJobQueueSchema(drizzle(owner), undefined, undefined, [`batch=${role}`]);
      await clearBatchJobFixture(ownerDatabase);
      await seedBatchJobFixture(ownerDatabase);
      await seedClimbNeighborFixture(ownerDatabase);
      vi.stubGlobal('fetch', async () => Response.json({ results: posthogSendRows() }));
      vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'test-personal-key');

      // Twice: the second night takes the replace path, whose playlist_climbs
      // delete fires the sync_deletions trigger.
      await refreshRecommendationsFamily.execute(context('refresh-recommendations'), {});
      await refreshRecommendationsFamily.execute(context('refresh-recommendations'), {});
      await refreshHoldFeaturesFamily.execute(
        context('refresh-hold-features'),
        refreshHoldFeaturesFamily.payload.parse({}),
      );
      expect(
        await ownerDatabase
          .select()
          .from(dbSchema.userHoldClassifications)
          .where(inArray(dbSchema.userHoldClassifications.userId, ['system-hold-classifier'])),
      ).not.toHaveLength(0);
      // Every read of a real run, ending at the blocking backtest.
      await expect(refreshClimbGradesFamily.execute(context('refresh-climb-grades'), {})).rejects.toMatchObject({
        code: 'GATES_FAILED',
      });
      // The publish path, with the backtest skipped as on a dev database.
      const published = await runRefreshClimbGrades({
        db: database,
        signal: new AbortController().signal,
        transact: (callback) => database.transaction((transaction) => callback(transaction)),
        log: { info: () => {}, warn: () => {} },
        refit: true,
        dryRun: false,
        validateOnly: false,
        allowEmptyBacktest: true,
        publishCrossAngleEstimates: false,
      });
      expect(published.mode).toBe('published');
      expect(
        await ownerDatabase
          .select()
          .from(dbSchema.boardClimbGrades)
          .where(inArray(dbSchema.boardClimbGrades.climbUuid, KILTER_CLIMBS)),
      ).toHaveLength(KILTER_CLIMBS.length);

      // The neighbours job, every write path: a full build (build state, chunks,
      // finished groups, the sweep and watermark), an incremental night with
      // the gap scan (the work-set delete), and a build cut off and resumed.
      await refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors'), { board: NEIGHBOR_BOARD });
      await insertNeighborClimb(ownerDatabase, {
        uuid: `${FIXTURE_PREFIX}nb-late`,
        layoutId: NEIGHBOR_LARGE_LAYOUT,
        holds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40],
      });
      await refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors'), {
        board: NEIGHBOR_BOARD,
        refillGaps: true,
      });
      expect(
        await ownerDatabase
          .select()
          .from(dbSchema.boardClimbNeighbors)
          .where(eq(dbSchema.boardClimbNeighbors.climbUuid, NEIGHBOR_LARGE_CLIMBS[0])),
      ).toHaveLength(NEIGHBOR_LARGE_CLIMBS.length);
      const stopped = new AbortController();
      await expect(
        runRefreshClimbNeighbors({
          db: database,
          signal: stopped.signal,
          transact: (callback) => database.transaction((transaction) => callback(transaction)),
          log: {
            info: (line) => {
              if (line.includes('processed')) stopped.abort();
            },
            warn: () => {},
          },
          boards: [NEIGHBOR_BOARD],
          full: true,
          dryRun: false,
          refillGaps: false,
        }),
      ).rejects.toMatchObject({ name: 'ClimbNeighborsInterruptedError' });
      await refreshClimbNeighborsFamily.execute(context('refresh-climb-neighbors'), {
        board: NEIGHBOR_BOARD,
        refillGaps: false,
      });
      const [neighborRun] = await ownerDatabase
        .select()
        .from(dbSchema.boardClimbNeighborRuns)
        .where(eq(dbSchema.boardClimbNeighborRuns.boardType, NEIGHBOR_BOARD));
      expect(neighborRun.fullBuildStartedAt).toBeNull();
      // The two MoonBoard estimate families need no grants beyond the grade
      // job's own list above (board_climb_stats/board_climbs SELECT,
      // board_climb_grades and board_grade_coefficients DML, including the
      // SELECT both jobs make on board_climb_grades), proven by running both
      // for real under the same restricted role.
      await refreshMoonboardAngleEstimatesFamily.execute(context('refresh-moonboard-angle-estimates'), {
        publish: true,
      });
      expect(
        await ownerDatabase
          .select()
          .from(dbSchema.boardClimbGrades)
          .where(eq(dbSchema.boardClimbGrades.confidence, 'moonboard_angle_estimate')),
      ).toMatchObject([{ boardType: 'moonboard', climbUuid: MOONBOARD_CLIMB, angle: 25 }]);
      // The wide-angle job needs a shape board: the owner seeds a Tension angle
      // surface and one stale wide estimate, then the family publishes (chunked
      // upserts, then the reap's DELETE) under the restricted role.
      await seedWideAngleShapeFixture(ownerDatabase);
      await refreshMoonboardWideAngleEstimatesFamily.execute(context('refresh-moonboard-wide-angle-estimates'), {
        publish: true,
      });
      const wide = await ownerDatabase
        .select()
        .from(dbSchema.boardClimbGrades)
        .where(eq(dbSchema.boardClimbGrades.confidence, 'moonboard_wide_angle_estimate'));
      const ladder = wide
        .filter((row) => row.climbUuid === MOONBOARD_CLIMB)
        .map((row) => row.angle)
        .sort((left, right) => left - right);
      expect(ladder).toEqual([...MOONBOARD_WIDE_LADDER_ANGLES]);
      expect(wide.some((row) => row.climbUuid === MOONBOARD_STALE_WIDE_CLIMB)).toBe(false);

      // Nothing beyond the list: no user data it does not need, no catalog writes.
      await expect(restricted`SELECT email FROM users LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`SELECT comment FROM boardsesh_ticks LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`SELECT session_id FROM boardsesh_ticks LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`SELECT name FROM user_boards LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`SELECT id FROM aurora_credentials LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`DELETE FROM board_climbs WHERE uuid = 'none'`).rejects.toThrow('permission denied');
      await expect(restricted`UPDATE board_climbs SET name = name WHERE false`).rejects.toThrow('permission denied');
      await expect(restricted`DELETE FROM background_job_runs WHERE false`).rejects.toThrow('permission denied');

      // The list is authoritative: re-running with a bare login strips it.
      await initializeJobQueueSchema(drizzle(owner), undefined, undefined, [role]);
      await expect(restricted`SELECT uuid FROM board_climbs LIMIT 1`).rejects.toThrow('permission denied');
      // Column-level grants too: a table-level REVOKE alone would leave these.
      await expect(restricted`SELECT climb_uuid FROM boardsesh_ticks LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`SELECT gym_id FROM user_boards LIMIT 1`).rejects.toThrow('permission denied');
      await expect(restricted`SELECT id FROM users LIMIT 1`).rejects.toThrow('permission denied');
      const [leftover] = await owner`
        SELECT count(*)::int AS columns
        FROM pg_attribute attribute
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
        WHERE attribute.attacl IS NOT NULL AND privilege.grantee = to_regrole(${role})`;
      expect(leftover.columns).toBe(0);
      expect(await restricted`SELECT id FROM background_job_runs LIMIT 1`).toBeDefined();
    } finally {
      await restricted.end();
      await clearBatchJobFixture(ownerDatabase);
      await owner.unsafe(`DROP OWNED BY "${role}"`);
      await owner.unsafe(`DROP ROLE "${role}"`);
      await owner.end();
    }
  }, 60_000);
});
