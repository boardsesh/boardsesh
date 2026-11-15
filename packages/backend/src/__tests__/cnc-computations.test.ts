import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns, cncComputations, users } from '@boardsesh/db/schema';
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../services/cnc/generator-process', async (original) => ({
  ...(await original<typeof import('../services/cnc/generator-process')>()),
  runCncGenerator: generate,
}));
import { db } from '../db/client';
import { requireJobQueue, startJobQueue, stopJobQueue } from '../services/job-queue';
import { executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../workers/jobs';
import { readCncComputation, submitCncComputation } from '../services/cnc/computations';
import { clearExpiredCncComputations } from '../services/cnc/computation-retention';
import { CncGeneratorError } from '../services/cnc/generator-process';
const connection = new URL(process.env.DATABASE_URL!);
// Refuse even fixture cleanup outside the dedicated local per-worker test database.
if (
  !['localhost', '127.0.0.1'].includes(connection.hostname) ||
  !connection.pathname.startsWith('/boardsesh_backend_test_w')
)
  throw new Error('LOCAL_ISOLATED_TEST_DATABASE_REQUIRED');
const owner = postgres(connection.toString(), { max: 1, onnotice: () => {} });
const queue = BACKGROUND_JOB_QUEUES['cnc-interactive'];
const generatorSha = randomUUID().replaceAll('-', '').padEnd(40, 'a');
const ownerId = `cnc-owner-${randomUUID()}`;
const otherId = `cnc-other-${randomUUID()}`;
const requestIds = new Set<string>();
const runIds = new Set<string>();
const layoutRequest = { board: { board_name: 'kilter', layout_id: 8, size_id: 17, set_ids: [26, 27] } };
async function submit(viewer: string | null = null) {
  const result = await submitCncComputation({
    operation: 'layout',
    ownerId: viewer,
    request: { layoutRequest, includeHoles: viewer !== null },
  });
  requestIds.add(result.id);
  const [request] = await db.select().from(cncComputations).where(eq(cncComputations.id, result.id));
  runIds.add(request.runId);
  return result;
}
async function execute() {
  const [job] = await requireJobQueue().fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
  if (!job || !runIds.has(job.id)) throw new Error('Expected only a job created by this test');
  return executeBackgroundJob(
    db,
    requireJobQueue(),
    job,
    handlerForRole('cnc-interactive'),
    new AbortController().signal,
  );
}
beforeAll(async () => {
  const ledger = await db.execute(sql`SELECT to_regclass('public.background_job_runs') AS ledger`);
  if (!ledger[0]?.ledger) {
    await db.execute(
      sql.raw(readFileSync(new URL('../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8')),
    );
    await db.execute(
      sql.raw(readFileSync(new URL('../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8')),
    );
  }
  await initializeJobQueueSchema(drizzle(owner));
  await startJobQueue();
  await db.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.com`, name: 'CNC test owner' },
    { id: otherId, email: `${otherId}@example.com`, name: 'Other test owner' },
  ]);
});
beforeEach(() => {
  vi.stubEnv('CNC_TRANSPORT', 'pgboss');
  vi.stubEnv('CNC_GENERATOR_SHA', generatorSha);
  generate
    .mockReset()
    .mockResolvedValue({ buildSha: generatorSha, generatorVersion: '0.1.0', result: { panels: [{ role: 'main' }] } });
});
afterEach(async () => {
  // Only newly-created fixtures, never all computations, orders, users or ledger rows.
  for (const runId of runIds) await requireJobQueue().cancel(queue, runId);
  if (requestIds.size) await db.delete(cncComputations).where(inArray(cncComputations.id, [...requestIds]));
  if (runIds.size) await db.delete(backgroundJobRuns).where(inArray(backgroundJobRuns.id, [...runIds]));
  requestIds.clear();
  runIds.clear();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await stopJobQueue();
  await owner.end();
});
describe('durable CNC computations in an isolated local database', () => {
  it('queues only the request ID and publishes a fenced result without generic job output', async () => {
    const submitted = await submit();
    const [run] = await db
      .select()
      .from(backgroundJobRuns)
      .where(inArray(backgroundJobRuns.id, [...runIds]));
    expect(run.payload).toEqual({ requestId: submitted.id });
    expect(await execute()).toBe('succeeded');
    expect(await readCncComputation(submitted.id, null)).toMatchObject({
      status: 'ready',
      result: { panels: [{ role: 'main' }] },
    });
    expect((await requireJobQueue().getJobById(queue, run.id))?.output).toBeNull();
  });
  it('restricts private holes to their owner while keeping hole-free layouts public', async () => {
    const privateRequest = await submit(ownerId);
    expect(await readCncComputation(privateRequest.id, null)).toBeNull();
    expect(await readCncComputation(privateRequest.id, otherId)).toBeNull();
    expect(await readCncComputation(privateRequest.id, ownerId)).toMatchObject({ id: privateRequest.id });
    const publicRequest = await submit();
    expect(await readCncComputation(publicRequest.id, otherId)).toMatchObject({ id: publicRequest.id });
  });
  it('refuses private submissions without an owner', async () => {
    await expect(submitCncComputation({ operation: 'artwork', ownerId: null, request: {} })).rejects.toThrow(
      'CNC_PRIVATE_COMPUTATION_REQUIRES_OWNER',
    );
    await expect(
      submitCncComputation({ operation: 'layout', ownerId: null, request: { includeHoles: true } }),
    ).rejects.toThrow('CNC_PRIVATE_COMPUTATION_REQUIRES_OWNER');
  });
  it('scopes cached results by owner and gives each queued row its own job', async () => {
    const first = await submit(ownerId);
    expect((await submit(ownerId)).id).not.toBe(first.id);
    expect(await execute()).toBe('succeeded');
    expect((await submit(ownerId)).id).toBe(first.id);
    expect((await submit(otherId)).id).not.toBe(first.id);
  });
  it('rejects publication after losing the attempt fence', async () => {
    const submitted = await submit();
    generate.mockImplementationOnce(async () => {
      await db
        .update(backgroundJobRuns)
        .set({ attemptToken: randomUUID() })
        .where(inArray(backgroundJobRuns.id, [...runIds]));
      return { buildSha: generatorSha, generatorVersion: '0.1.0', result: { stale: true } };
    });
    expect(await execute()).toBe('stale');
    expect(await readCncComputation(submitted.id, null)).toMatchObject({ result: null });
  });
  it('keeps unsafe-cut validation separate from infrastructure failures', async () => {
    const submitted = await submit();
    generate.mockRejectedValueOnce(new CncGeneratorError('SEAM_TOO_CLOSE_TO_HOLE', false));
    expect(await execute()).toBe('succeeded');
    expect(await readCncComputation(submitted.id, null)).toMatchObject({
      status: 'failed',
      errorCode: 'SEAM_TOO_CLOSE_TO_HOLE',
      result: null,
    });
  });
  it('fails closed for exhausted jobs and expired results', async () => {
    const submitted = await submit();
    await db
      .update(backgroundJobRuns)
      .set({ status: 'failed' })
      .where(inArray(backgroundJobRuns.id, [...runIds]));
    expect(await readCncComputation(submitted.id, null)).toMatchObject({
      status: 'failed',
      errorCode: 'CNC_WORKER_UNAVAILABLE',
    });
    await db
      .update(cncComputations)
      .set({ status: 'ready', result: { stale: true }, expiresAt: new Date(0) })
      .where(eq(cncComputations.id, submitted.id));
    expect(await readCncComputation(submitted.id, null)).toMatchObject({ status: 'failed', result: null });
  });
  it('reclaims only results expired over 24 hours and preserves current work', async () => {
    const expired = await submit();
    const current = await submit(ownerId);
    await db
      .update(cncComputations)
      .set({ expiresAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(cncComputations.id, expired.id));
    expect(await clearExpiredCncComputations(db)).toBe(1);
    expect(await readCncComputation(expired.id, null)).toBeNull();
    expect(await readCncComputation(current.id, ownerId)).not.toBeNull();
  });
});
