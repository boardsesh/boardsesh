import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbInstance } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { ensureBackgroundJobSchema } from '../workers/families/__tests__/provider-sync-fixtures';
import { executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../workers/jobs';
import { assertWorkerPrivileges } from '../services/job-queue-client';
import {
  getUserDataExportDownloadLink,
  getUserDataExportStatus,
  requestUserDataExport,
} from '../services/user-data-export';

const queueState = vi.hoisted(() => ({ boss: null as PgBoss | null }));
const objects = vi.hoisted(
  () => new Map<string, { body: Buffer; metadata?: Record<string, string>; lastModified: Date }>(),
);
vi.mock('../services/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/job-queue')>()),
  getJobQueue: () => queueState.boss,
}));
vi.mock('../storage/s3', () => ({
  isS3Configured: () => true,
  getS3ObjectMetadataStrict: async (_bucket: string, key: string) => {
    const object = objects.get(key);
    return object
      ? {
          contentLength: object.body.length,
          contentType: 'application/json',
          metadata: object.metadata,
          lastModified: object.lastModified,
        }
      : null;
  },
  getFromS3Strict: async (_bucket: string, key: string) => {
    const object = objects.get(key);
    return object
      ? { stream: Readable.from([object.body]), contentType: 'application/json', contentLength: object.body.length }
      : null;
  },
  uploadToS3: async (
    _bucket: string,
    body: Buffer,
    key: string,
    _contentType: string,
    options: { metadata?: Record<string, string> },
  ) => {
    if (objects.has(key)) throw Object.assign(new Error('Exists'), { $metadata: { httpStatusCode: 412 } });
    objects.set(key, { body, metadata: options.metadata, lastModified: new Date() });
    return { key };
  },
  presignGetObject: async () => ({
    url: 'https://r2.test/private-signed',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  }),
}));

const queue = BACKGROUND_JOB_QUEUES['maintenance-delivery'];
const role = `export_worker_${randomUUID().replaceAll('-', '')}`;
const userId = `export-jobs-${randomUUID()}`;
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const restrictedUrl = new URL(process.env.DATABASE_URL!);
restrictedUrl.searchParams.set('options', `-c role=${role}`);
const restricted = postgres(restrictedUrl.toString(), { max: 2, onnotice: () => {} });
const workerDatabase = drizzle(restricted) as unknown as DbInstance;
const ownerBoss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
const workerBoss = new PgBoss({
  connectionString: restrictedUrl.toString(),
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
ownerBoss.on('error', () => {});
workerBoss.on('error', () => {});

beforeAll(async () => {
  await owner.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
  await ensureBackgroundJobSchema(owner, [`maintenance-delivery=${role}`]);
  await ownerBoss.start();
  await workerBoss.start();
  queueState.boss = ownerBoss;
}, 30000);
beforeEach(async () => {
  vi.stubEnv('BATCH_FAMILIES_ENABLED', 'user-data-export');
  objects.clear();
  await ownerBoss.deleteAllJobs(queue);
  await db.delete(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'user-data-export'));
  await db
    .insert(users)
    .values({ id: userId, name: 'Export climber', email: `${userId}@example.com` })
    .onConflictDoNothing();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(users).where(eq(users.id, userId));
});
afterAll(async () => {
  queueState.boss = null;
  await workerBoss.stop({ graceful: true, close: true });
  await ownerBoss.stop({ graceful: true, close: true });
  await restricted.end();
  await db.delete(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'user-data-export'));
  await owner.unsafe(`DROP OWNED BY "${role}"`);
  await owner.unsafe(`DROP ROLE "${role}"`);
  await owner.end();
});

async function allRuns() {
  return db.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'user-data-export'));
}
async function failRun(id: string) {
  await ownerBoss.cancel(queue, id);
  await db
    .update(backgroundJobRuns)
    .set({ status: 'failed', finishedAt: new Date(Date.now() - 6 * 60000) })
    .where(eq(backgroundJobRuns.id, id));
}

describe('durable export producers and restricted workers', () => {
  it('coalesces sixteen producers and avoids active-plus-created duplicates', async () => {
    const requested = await Promise.all(Array.from({ length: 16 }, () => requestUserDataExport(userId, 'kilter')));
    expect(requested.every((status) => status.status === 'generating')).toBe(true);
    expect(await allRuns()).toHaveLength(1);
    const [active] = await ownerBoss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    expect(active).toBeDefined();
    await Promise.all(Array.from({ length: 8 }, () => requestUserDataExport(userId, 'kilter')));
    expect(await allRuns()).toHaveLength(1);
    const jobs = await ownerBoss.findJobs(queue, { key: `user-data-export:${userId}:kilter:${requested[0].period}` });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('active');
  }, 30000);

  it('generates both formats under exactly the maintenance worker grants', async () => {
    const requested = await requestUserDataExport(userId, 'kilter');
    expect(requested.status).toBe('generating');
    await assertWorkerPrivileges(workerBoss.getDb());
    const [job] = await workerBoss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    const result = await executeBackgroundJob(
      workerDatabase,
      workerBoss,
      job,
      handlerForRole('maintenance-delivery'),
      new AbortController().signal,
    );
    const [run] = await allRuns();
    expect({ result, status: run.status, errorCode: run.errorCode }).toEqual({
      result: 'succeeded',
      status: 'succeeded',
      errorCode: null,
    });
    const status = await getUserDataExportStatus(userId, 'kilter');
    expect(status.status).toBe('ready');
    expect(status.files.map((file) => file.format)).toEqual(['boardsesh', 'aurora']);
    expect(objects.size).toBe(2);
    await expect(restricted`SELECT id FROM aurora_credentials LIMIT 1`).rejects.toThrow('permission denied');
    await expect(restricted`UPDATE board_climbs SET name = name WHERE false`).rejects.toThrow('permission denied');
    await expect(restricted`DELETE FROM background_job_runs WHERE false`).rejects.toThrow('permission denied');
  }, 30000);

  it('caps manual jobs at two per week after the retry cooldown', async () => {
    await requestUserDataExport(userId, 'kilter');
    const [first] = await allRuns();
    await failRun(first.id);
    expect((await requestUserDataExport(userId, 'kilter')).status).toBe('generating');
    const runs = await allRuns();
    expect(runs).toHaveLength(2);
    for (const run of runs) await failRun(run.id);
    const declined = await requestUserDataExport(userId, 'kilter');
    expect(declined.status).toBe('failed');
    expect(declined.retryAt).toBe(declined.refreshAt);
    expect(await allRuns()).toHaveLength(2);
  });

  it('rejects deleted accounts even when their generated files remain privately stored', async () => {
    const requested = await requestUserDataExport(userId, 'woods');
    const [job] = await workerBoss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    expect(
      await executeBackgroundJob(
        workerDatabase,
        workerBoss,
        job,
        handlerForRole('maintenance-delivery'),
        new AbortController().signal,
      ),
    ).toBe('succeeded');
    expect(objects.size).toBe(1);
    await db.delete(users).where(eq(users.id, userId));
    await expect(getUserDataExportDownloadLink(userId, 'woods', requested.period, 'boardsesh')).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });
});
