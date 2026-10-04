/** Real pg-boss attempts and publication fences; storage/export bodies are mocked. */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createDb } from '@boardsesh/db/client';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { BACKGROUND_JOB_QUEUES, BACKGROUND_JOB_QUEUE_OPTIONS } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import type { SnapshotExportDependencies, SnapshotExportOptions } from '../../scripts/export-board-snapshots';

const exporter = vi.hoisted(() => ({ run: vi.fn(), published: vi.fn() }));
vi.mock('../../scripts/export-board-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scripts/export-board-snapshots')>()),
  runExportWithOptions: exporter.run,
  snapshotPublicBaseUrl: () => 'https://snapshots.example',
}));
vi.mock('../../storage/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../storage/s3')>()),
  isS3Configured: () => true,
}));

const { enqueueBackgroundJob, executeBackgroundJob, handlerForRole } = await import('../jobs');
const { exportBoardSnapshotsFamily: family } = await import('../families/export-board-snapshots');
const database = createDb();
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const queue = BACKGROUND_JOB_QUEUES.batch;
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
boss.on('error', () => {});

beforeAll(async () => {
  const [ledger] = await owner`SELECT to_regclass('public.background_job_runs') AS present`;
  if (!ledger.present) {
    await owner.unsafe(
      readFileSync(new URL('../../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8'),
    );
  }
  const [familyColumn] = await owner`SELECT 1 AS present FROM information_schema.columns
    WHERE table_schema='public' AND table_name='background_job_runs' AND column_name='family'`;
  if (!familyColumn) {
    await owner.unsafe(
      readFileSync(new URL('../../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8'),
    );
  }
  await initializeJobQueueSchema(drizzle(owner));
  await boss.start();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await boss.deleteAllJobs(queue);
  await database.delete(backgroundJobRuns);
  exporter.run.mockImplementation(async (options: SnapshotExportOptions, dependencies: SnapshotExportDependencies) => {
    await dependencies.beforeManifestPublish?.();
    exporter.published(options.keyPrefix);
  });
});
afterAll(async () => {
  await boss.deleteAllJobs(queue);
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

async function snapshotAttempt() {
  const { runId } = await enqueueBackgroundJob(database, boss, {
    family: family.name,
    payload: { mode: 'nightly', board: 'kilter', layout: 1, skipPrune: true },
  });
  const [job] = await boss.fetch<{ runId: string }>(queue, { includeMetadata: true, batchSize: 1 });
  expect(job.id).toBe(runId);
  return job;
}

describe('homelab snapshot attempt lease', () => {
  it('persists the snapshot budget per job without changing the shared batch queue', async () => {
    const job = await snapshotAttempt();
    const [stored] = await owner`SELECT expire_seconds, heartbeat_seconds, retry_limit, retry_delay, singleton_key, data
      FROM pgboss.job WHERE name=${queue} AND id=${job.id}`;
    expect(stored).toMatchObject({
      expire_seconds: 21_600,
      heartbeat_seconds: 120,
      retry_limit: 1,
      retry_delay: 300,
      singleton_key: 'export-board-snapshots:nightly',
      data: { runId: job.id },
    });
    const [queueOptions] = await owner`SELECT expire_seconds FROM pgboss.queue WHERE name=${queue}`;
    expect(queueOptions.expire_seconds).toBe(BACKGROUND_JOB_QUEUE_OPTIONS.expireInSeconds);
    expect(queueOptions.expire_seconds).not.toBe(stored.expire_seconds);
    expect(job.expireInSeconds).toBe(stored.expire_seconds);
  });

  it('publishes both fenced manifests and settles a live attempt older than 45 minutes', async () => {
    const job = await snapshotAttempt();
    const [aged] = await owner<
      { started_on: string }[]
    >`UPDATE pgboss.job SET started_on=now()-interval '46 minutes', heartbeat_on=now()
      WHERE name=${queue} AND id=${job.id} RETURNING started_on`;
    job.startedOn = new Date(aged.started_on);
    expect(await executeBackgroundJob(database, boss, job, handlerForRole('batch'), new AbortController().signal)).toBe(
      'succeeded',
    );
    expect(exporter.published.mock.calls).toEqual([['board-snapshots/v1'], ['board-snapshots/v1-gzip']]);
    expect((await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, job.id)))[0].status).toBe(
      'succeeded',
    );
    expect((await boss.getJobById(queue, job.id))?.state).toBe('completed');
  });

  it('refuses publication when the absolute six-hour lease expires after claiming', async () => {
    const job = await snapshotAttempt();
    exporter.run.mockImplementationOnce(
      async (_options: SnapshotExportOptions, dependencies: SnapshotExportDependencies) => {
        await owner`UPDATE pgboss.job SET started_on=now()-interval '6 hours 1 second', heartbeat_on=now()
        WHERE name=${queue} AND id=${job.id}`;
        await dependencies.beforeManifestPublish?.();
        exporter.published('expired');
      },
    );
    expect(await executeBackgroundJob(database, boss, job, handlerForRole('batch'), new AbortController().signal)).toBe(
      'stale',
    );
    expect(exporter.published).not.toHaveBeenCalled();
    expect(exporter.run).toHaveBeenCalledTimes(1);
    expect((await boss.getJobById(queue, job.id))?.state).toBe('active');
  });

  it('still rejects a missed 120-second heartbeat before exporting', async () => {
    const job = await snapshotAttempt();
    await owner`UPDATE pgboss.job SET heartbeat_on=now()-interval '121 seconds'
      WHERE name=${queue} AND id=${job.id}`;
    expect(await executeBackgroundJob(database, boss, job, handlerForRole('batch'), new AbortController().signal)).toBe(
      'stale',
    );
    expect(exporter.run).not.toHaveBeenCalled();
    expect(exporter.published).not.toHaveBeenCalled();
  });
});
