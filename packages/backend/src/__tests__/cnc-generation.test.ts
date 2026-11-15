import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns, cncOrders, type CncOrder, type CncOrderOptions } from '@boardsesh/db/schema';

const { generatorMock, metadataMock, objectMock, readyMailMock, failedMailMock, analyticsMock } = vi.hoisted(() => ({
  generatorMock: vi.fn(),
  metadataMock: vi.fn(),
  objectMock: vi.fn(),
  readyMailMock: vi.fn(async () => true),
  failedMailMock: vi.fn(async () => true),
  analyticsMock: vi.fn(),
}));

vi.mock('../services/cnc/generator-process', async (original) => ({
  ...(await original<typeof import('../services/cnc/generator-process')>()),
  runCncGenerator: generatorMock,
}));
vi.mock('../storage/s3', async (original) => ({
  ...(await original<typeof import('../storage/s3')>()),
  isS3Configured: () => true,
  getBucketName: () => 'private-test',
  getS3ObjectMetadataStrict: metadataMock,
  getFromS3Strict: objectMock,
}));
vi.mock('../email/cnc-emails', () => ({
  sendCncPackReadyEmail: readyMailMock,
  sendCncPackFailedAdminEmail: failedMailMock,
}));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: analyticsMock }));

import { db } from '../db/client';
import { getJobQueue, requireJobQueue, startJobQueue, stopJobQueue } from '../services/job-queue';
import { executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../workers/jobs';
import { createPreviewOrder, getOrderById, toPublicOrder, transitionOrder } from '../services/cnc/orders';
import { enqueueCncGenerationOn, reconcileCncGenerationRuns } from '../services/cnc/generation-queue';
import { CncGeneratorError } from '../services/cnc/generator-process';
import { CNC_CATALOG_VERSION } from '../services/cnc/catalog';

const queue = BACKGROUND_JOB_QUEUES['cnc-generation'];
// The owner-only pg-boss bootstrap contains BEGIN/COMMIT and needs one reserved connection.
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const files = new Map<string, Buffer>();
const fixtureOrderIds = new Set<number>();
const fixtureRunIds = new Set<string>();
let localTestDatabaseVerified = false;

/** The queue call exposes this operation's run ID even when its transaction rolls back. */
function sentRunIds(calls: readonly (readonly unknown[])[]): string[] {
  return calls.flatMap(([queueName, payload]) => {
    if (queueName !== queue) return [];
    if (!payload || typeof payload !== 'object' || !('runId' in payload) || typeof payload.runId !== 'string') {
      throw new Error('Expected an addressed CNC queue run');
    }
    fixtureRunIds.add(payload.runId);
    return [payload.runId];
  });
}

async function findOwnedRuns(runIds: string[]) {
  if (!runIds.length) throw new Error('Expected at least one captured CNC run ID');
  return db.select().from(backgroundJobRuns).where(inArray(backgroundJobRuns.id, runIds));
}

async function clearFixtures(): Promise<void> {
  if (!localTestDatabaseVerified) return;
  if (fixtureOrderIds.size) {
    const orders = await db
      .select({ runId: cncOrders.generationRunId })
      .from(cncOrders)
      .where(inArray(cncOrders.id, [...fixtureOrderIds]));
    for (const order of orders) if (order.runId) fixtureRunIds.add(order.runId);
  }
  if (fixtureRunIds.size) {
    if (getJobQueue()) await requireJobQueue().deleteJob(queue, [...fixtureRunIds]);
    await db.delete(backgroundJobRuns).where(inArray(backgroundJobRuns.id, [...fixtureRunIds]));
  }
  if (fixtureOrderIds.size) await db.delete(cncOrders).where(inArray(cncOrders.id, [...fixtureOrderIds]));
  fixtureOrderIds.clear();
  fixtureRunIds.clear();
}
const options: CncOrderOptions = {
  sheetStock: '2440x1220',
  panelThicknessMm: 18,
  tnutHoleDiameterMm: 12.5,
  ledHoleDiameterMm: 12.5,
  kickerMatClearanceMm: 50,
  studClearanceOffsetMm: 60,
  gridPitchMm: 100,
  dxfFlavour: 'R12_circles',
  paper: 'A3',
  supportStrips: true,
  engraveHoldIds: false,
  engraveAngleTicks: false,
};

async function fixture(status: CncOrder['status'] = 'preview_queued'): Promise<CncOrder> {
  const [order] = await db
    .insert(cncOrders)
    .values({
      licenceId: `BS-CNC-${randomUUID().slice(0, 8).toUpperCase()}`,
      userId: 'user-123',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      options,
      catalogVersion: CNC_CATALOG_VERSION,
      configHash: randomUUID(),
      status,
      tier: status.startsWith('preview') ? null : 'personal',
      licenseeName: 'Test Buyer',
      licenseeEmail: 'user-123@test.com',
      paidAt: status.startsWith('preview') || status === 'pending_payment' ? null : new Date(),
      queuedAt: new Date(),
    })
    .returning();
  fixtureOrderIds.add(order.id);
  return order;
}

async function enqueue(order: CncOrder): Promise<CncOrder> {
  const attached = await db.transaction((transaction) => enqueueCncGenerationOn(transaction, order));
  fixtureOrderIds.add(attached.id);
  if (attached.generationRunId) fixtureRunIds.add(attached.generationRunId);
  return attached;
}

async function fetchJob() {
  const [job] = await requireJobQueue().fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
  if (!job) throw new Error('Expected queued generation');
  return job;
}

async function execute() {
  return executeBackgroundJob(
    db,
    requireJobQueue(),
    await fetchJob(),
    handlerForRole('cnc-generation'),
    new AbortController().signal,
  );
}

function generated(operation: string, payload: Record<string, unknown>) {
  const zipKey = String(payload.outputKey);
  const zip = Buffer.from(`manufacturing-${zipKey}`);
  files.set(zipKey, zip);
  const previewKeys = operation === 'preview' ? [`${String(payload.previewPrefix)}panel1.png`] : [];
  for (const key of previewKeys) files.set(key, Buffer.from('preview-png'));
  return {
    buildSha: 'a'.repeat(40),
    generatorVersion: '0.1.0',
    result: {
      zipKey,
      sizeBytes: zip.length,
      sha256: createHash('sha256').update(zip).digest('hex'),
      fingerprintManifest: operation === 'preview' ? null : { privateMarks: 'kept-only-on-order' },
      bomSummary: { panel_count: 6 },
      previewKeys,
      generatorVersion: '0.1.0',
    },
  };
}

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL!);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    !target.pathname.startsWith('/boardsesh_backend_test')
  ) {
    throw new Error('CNC integration tests require an isolated local boardsesh_backend_test database');
  }
  localTestDatabaseVerified = true;
  const existing = await db.execute(sql`SELECT to_regclass('public.background_job_runs') AS ledger`);
  if (!existing[0]?.ledger) {
    await db.execute(
      sql.raw(readFileSync(new URL('../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8')),
    );
    await db.execute(
      sql.raw(readFileSync(new URL('../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8')),
    );
  }
  await initializeJobQueueSchema(drizzle(owner));
  await startJobQueue();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubEnv('CNC_TRANSPORT', 'pgboss');
  await clearFixtures();
  files.clear();
  generatorMock
    .mockReset()
    .mockImplementation(async (operation: string, payload: Record<string, unknown>) => generated(operation, payload));
  metadataMock.mockReset().mockImplementation(async (_bucket: string, key: string) => {
    const content = files.get(key);
    return content
      ? { contentLength: content.length, contentType: key.endsWith('.png') ? 'image/png' : 'application/zip' }
      : null;
  });
  objectMock.mockReset().mockImplementation(async (_bucket: string, key: string) => {
    const content = files.get(key);
    return content ? { contentLength: content.length, stream: Readable.from([content]) } : null;
  });
  readyMailMock.mockClear();
  failedMailMock.mockClear();
  analyticsMock.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await clearFixtures();
  if (getJobQueue()) await stopJobQueue();
  await owner.end();
});

describe('CNC pg-boss generation', () => {
  it('adopts legacy queued rows once across replicas and fetches paid work before earlier previews', async () => {
    const preview = await fixture();
    const paid = await fixture('queued');
    const unpaid = await fixture('pending_payment');
    const send = vi.spyOn(requireJobQueue(), 'send');
    await Promise.all([reconcileCncGenerationRuns(db), reconcileCncGenerationRuns(db)]);
    await reconcileCncGenerationRuns(db);
    const runIds = sentRunIds(send.mock.calls);
    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
    const runs = await findOwnedRuns(runIds);
    expect(runs).toHaveLength(2);
    expect((await getOrderById(unpaid.id))?.generationRunId).toBeNull();
    const first = await fetchJob();
    expect(first.id).toBe((await getOrderById(paid.id))?.generationRunId);
    const second = await fetchJob();
    expect(second.id).toBe((await getOrderById(preview.id))?.generationRunId);
  });

  it('rolls preview creation back with a failed queue insert, then creates one addressed job', async () => {
    const input = {
      userId: 'user-123',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
      options,
      configHash: randomUUID(),
    };
    const send = vi.spyOn(requireJobQueue(), 'send').mockRejectedValueOnce(new Error('QUEUE_UNAVAILABLE'));
    await expect(createPreviewOrder(input)).rejects.toThrow('QUEUE_UNAVAILABLE');
    expect(await db.select().from(cncOrders).where(eq(cncOrders.configHash, input.configHash))).toHaveLength(0);
    const attemptedRuns = sentRunIds(send.mock.calls);
    expect(attemptedRuns).toHaveLength(1);
    expect(await findOwnedRuns(attemptedRuns)).toHaveLength(0);
    const order = await createPreviewOrder(input);
    fixtureOrderIds.add(order.id);
    if (order.generationRunId) fixtureRunIds.add(order.generationRunId);
    const [run] = await db.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, order.generationRunId!));
    expect(run.payload).toEqual({ orderId: order.id, generation: 1, deliverable: 'preview' });
    expect((await requireJobQueue().getJobById(queue, run.id))?.data).toEqual({ runId: run.id });
  });

  it.each(['checkoutCompleted', 'regenerate'] as const)(
    'commits %s and its run together, including caller transactions',
    async (event) => {
      const order = await fixture(event === 'checkoutCompleted' ? 'pending_payment' : 'ready');
      const patch = event === 'regenerate' ? { generation: 2, attempts: 0 } : { paidAt: new Date() };
      const send = vi.spyOn(requireJobQueue(), 'send').mockRejectedValueOnce(new Error('QUEUE_UNAVAILABLE'));
      await expect(
        db.transaction((transaction) => transitionOrder(order.id, event, patch, { executor: transaction })),
      ).rejects.toThrow('QUEUE_UNAVAILABLE');
      expect((await getOrderById(order.id))?.status).toBe(order.status);
      const attemptedRuns = sentRunIds(send.mock.calls);
      expect(attemptedRuns).toHaveLength(1);
      expect(await findOwnedRuns(attemptedRuns)).toHaveLength(0);
      const queued = await transitionOrder(order.id, event, patch);
      expect(queued).toMatchObject({ status: 'queued', generation: event === 'regenerate' ? 2 : 1 });
      expect(queued?.generationRunId).toBeTruthy();
    },
  );

  it('publishes verified previews and lets the backend announce once across replicas', async () => {
    const order = await enqueue(await fixture());
    expect(await execute()).toBe('succeeded');
    const ready = await getOrderById(order.id);
    expect(ready).toMatchObject({ status: 'preview_ready', previewsGenerated: 1, attempts: 1 });
    expect(ready?.previewZipKey).toContain('/g1/preview/a1/');
    expect(generatorMock.mock.calls[0][1]).not.toHaveProperty('claimToken');
    expect(analyticsMock).not.toHaveBeenCalled();
    await Promise.all([reconcileCncGenerationRuns(db), reconcileCncGenerationRuns(db)]);
    expect(analyticsMock).toHaveBeenCalledTimes(1);
    expect(readyMailMock).not.toHaveBeenCalled();
    expect(toPublicOrder(ready!)).not.toHaveProperty('generationRunId');
    expect(toPublicOrder(ready!)).not.toHaveProperty('notificationClaimToken');
  });

  it('does not render or upload again after completion commits but queue acknowledgement fails', async () => {
    const order = await enqueue(await fixture('queued'));
    vi.spyOn(requireJobQueue(), 'complete').mockRejectedValueOnce(new Error('ACK_INTERRUPTED'));
    expect(await execute()).toBe('failed');
    expect((await getOrderById(order.id))?.status).toBe('ready');
    await db.execute(
      sql`UPDATE pgboss.job SET start_after = now() WHERE name = ${queue} AND id = ${order.generationRunId}`,
    );
    expect(await execute()).toBe('succeeded');
    expect(generatorMock).toHaveBeenCalledTimes(1);
    await Promise.all([reconcileCncGenerationRuns(db), reconcileCncGenerationRuns(db)]);
    expect(readyMailMock).toHaveBeenCalledTimes(1);
    expect((await requireJobQueue().getJobById(queue, order.generationRunId!))?.output).toBeNull();
  });

  it.each(['refund', 'new-generation'] as const)('refuses publication after %s wins during upload', async (change) => {
    const order = await enqueue(await fixture('queued'));
    generatorMock.mockImplementationOnce(async (operation: string, payload: Record<string, unknown>) => {
      const result = generated(operation, payload);
      await db
        .update(cncOrders)
        .set(
          change === 'refund'
            ? { status: 'refunded', refundedAt: new Date(), claimToken: null }
            : { generation: 2, generationRunId: randomUUID(), status: 'queued', claimToken: null },
        )
        .where(eq(cncOrders.id, order.id));
      return result;
    });
    expect(await execute()).toBe('succeeded');
    const current = await getOrderById(order.id);
    expect(current?.zipKey).toBeNull();
    expect(current?.status).toBe(change === 'refund' ? 'refunded' : 'queued');
    await reconcileCncGenerationRuns(db);
    expect(readyMailMock).not.toHaveBeenCalled();
  });

  it('isolates retried output from a stale attempt that finishes later', async () => {
    const order = await enqueue(await fixture('queued'));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    generatorMock.mockImplementationOnce(async (operation: string, payload: Record<string, unknown>) => {
      entered();
      await gate;
      return generated(operation, payload);
    });
    const first = execute();
    await started;
    try {
      await requireJobQueue().fail(queue, order.generationRunId!);
      await db.execute(
        sql`UPDATE pgboss.job SET start_after = now() WHERE name = ${queue} AND id = ${order.generationRunId}`,
      );
      expect(await execute()).toBe('succeeded');
      const winner = await getOrderById(order.id);
      expect(winner?.zipKey).toContain('/a2/pack.zip');
      release();
      expect(await first).toBe('stale');
      expect((await getOrderById(order.id))?.zipKey).toBe(winner?.zipKey);
      expect([...files.keys()].filter((key) => key.endsWith('/pack.zip'))).toHaveLength(2);
    } finally {
      release();
      await first;
    }
  });

  it.each(['upload', 'hash'] as const)(
    'keeps the order retryable after %s failure without publishing artifacts',
    async (failure) => {
      const order = await enqueue(await fixture());
      if (failure === 'upload') generatorMock.mockRejectedValueOnce(new CncGeneratorError('UPLOAD_FAILED', true));
      else
        generatorMock.mockImplementationOnce(async (operation: string, payload: Record<string, unknown>) => {
          const result = generated(operation, payload);
          result.result.sha256 = '0'.repeat(64);
          return result;
        });
      expect(await execute()).toBe('failed');
      expect(await getOrderById(order.id)).toMatchObject({
        status: 'preview_queued',
        attempts: 1,
        previewZipKey: null,
      });
      expect(analyticsMock).not.toHaveBeenCalled();
      expect(readyMailMock).not.toHaveBeenCalled();
    },
  );

  it('rejects unsafe artwork permanently before a preview becomes ready', async () => {
    const order = await enqueue(await fixture());
    generatorMock.mockRejectedValueOnce(new CncGeneratorError('ARTWORK_COLLISION', false));
    expect(await execute()).toBe('failed');
    expect(await getOrderById(order.id)).toMatchObject({ status: 'preview_failed', attempts: 1, previewZipKey: null });
    expect((await requireJobQueue().getJobById(queue, order.generationRunId!))?.state).toBe('cancelled');
  });

  it('recovers final-attempt crashes and never reaps ready, refunded, or superseded orders', async () => {
    const failed = await enqueue(await fixture('queued'));
    const ready = await enqueue(await fixture('queued'));
    const refunded = await enqueue(await fixture('queued'));
    const newer = await enqueue(await fixture('queued'));
    await db
      .update(backgroundJobRuns)
      .set({ status: 'failed', errorCode: 'DEADLINE_EXCEEDED' })
      .where(
        inArray(backgroundJobRuns.id, [
          failed.generationRunId!,
          ready.generationRunId!,
          refunded.generationRunId!,
          newer.generationRunId!,
        ]),
      );
    await db
      .update(cncOrders)
      .set({ status: 'generating', attempts: 3, claimToken: randomUUID() })
      .where(eq(cncOrders.id, failed.id));
    await db.update(cncOrders).set({ status: 'ready' }).where(eq(cncOrders.id, ready.id));
    await db.update(cncOrders).set({ status: 'refunded' }).where(eq(cncOrders.id, refunded.id));
    await db.update(cncOrders).set({ generation: 2, generationRunId: randomUUID() }).where(eq(cncOrders.id, newer.id));
    await Promise.all([reconcileCncGenerationRuns(db), reconcileCncGenerationRuns(db)]);
    expect((await getOrderById(failed.id))?.status).toBe('failed');
    expect((await getOrderById(ready.id))?.status).toBe('ready');
    expect((await getOrderById(refunded.id))?.status).toBe('refunded');
    expect((await getOrderById(newer.id))?.status).toBe('queued');
    expect(failedMailMock).toHaveBeenCalledTimes(1);
  });

  it('a preview notification never suppresses the paid notification in the same generation', async () => {
    const order = await enqueue(await fixture('queued'));
    await db
      .update(cncOrders)
      .set({ notificationGeneration: 1, notificationStatus: 'preview_ready' })
      .where(eq(cncOrders.id, order.id));
    expect(await execute()).toBe('succeeded');
    await reconcileCncGenerationRuns(db);
    expect(readyMailMock).toHaveBeenCalledTimes(1);
    const [notified] = await db
      .select()
      .from(cncOrders)
      .where(and(eq(cncOrders.id, order.id), eq(cncOrders.notificationStatus, 'ready')));
    expect(notified.notificationClaimToken).toBeNull();
  });

  it('keeps failed notification receipts unstamped and retries after its recovery lease', async () => {
    const order = await enqueue(await fixture('queued'));
    expect(await execute()).toBe('succeeded');
    readyMailMock.mockResolvedValueOnce(false);
    await reconcileCncGenerationRuns(db);
    expect(await getOrderById(order.id)).toMatchObject({
      notificationGeneration: 0,
      notificationStatus: null,
      notificationClaimToken: null,
    });
    expect((await getOrderById(order.id))?.notificationClaimedAt).toBeInstanceOf(Date);
    await reconcileCncGenerationRuns(db);
    expect(readyMailMock).toHaveBeenCalledTimes(1);
    await db
      .update(cncOrders)
      .set({ notificationClaimedAt: sql`clock_timestamp() - interval '11 minutes'` })
      .where(eq(cncOrders.id, order.id));
    await reconcileCncGenerationRuns(db);
    expect(readyMailMock).toHaveBeenCalledTimes(2);
    expect(await getOrderById(order.id)).toMatchObject({
      notificationGeneration: 1,
      notificationStatus: 'ready',
      notificationClaimedAt: null,
    });
  });

  it('limits one notification pass to three orders without dropping the remainder', async () => {
    for (let count = 0; count < 4; count++) {
      const order = await enqueue(await fixture('queued'));
      await db.update(cncOrders).set({ status: 'ready' }).where(eq(cncOrders.id, order.id));
    }
    await reconcileCncGenerationRuns(db);
    expect(readyMailMock).toHaveBeenCalledTimes(3);
    await reconcileCncGenerationRuns(db);
    expect(readyMailMock).toHaveBeenCalledTimes(4);
  });
});
