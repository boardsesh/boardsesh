import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_JOB_OPTIONS,
} from '@boardsesh/shared-schema';
import { users, sprayWalls, sprayWallVersions, sprayWallDetections } from '@boardsesh/db/schema';
import { claimSprayDetection, finishSprayDetection, retrySprayDetectionAttempt } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { startJobQueue, stopJobQueue } from '../services/job-queue';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import { sprayDetectionMutations, sprayDetectionQueries } from '../graphql/resolvers/board/spray-detection';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));
const context = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: userId }) as ConnectionContext;

async function draft() {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Detector test' });
  const owner = context(userId);
  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: 'Detector wall', angle: 40 } },
    owner,
  )) as { uuid: string };
  const [source] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, wall.uuid));
  const [version] = await db
    .insert(sprayWallVersions)
    .values({
      wallId: source.id,
      versionNumber: 1,
      status: 'draft',
      photoKey: `spray-walls/${wall.uuid}/test.jpg`,
      photoWidth: 800,
      photoHeight: 600,
    })
    .returning();
  return { owner, input: { wallUuid: wall.uuid, versionId: String(version.id) } };
}
const proposal = { width: 800, height: 600, candidates: [{ cx: 100, cy: 100, r: 10, confidence: 0.8 }] };

describe('durable spray recognition', () => {
  beforeAll(async () => {
    // Match the migrator's pinned owner connection, not the runtime pool:
    // pg-boss schema installation issues its own multi-statement transaction.
    const ownerClient = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await initializeJobQueueSchema(drizzle(ownerClient));
    } finally {
      await ownerClient.end();
    }
    const boss = await startJobQueue();
    await boss.createQueue(SPRAY_DETECTION_DEAD_QUEUE, { partition: false });
    await boss.createQueue(SPRAY_DETECTION_QUEUE, { partition: false, ...SPRAY_DETECTION_JOB_OPTIONS });
  });
  afterAll(async () => {
    await stopJobQueue();
  });

  it('deduplicates concurrent requests and prevents another owner reading results', async () => {
    const { owner, input } = await draft();
    const jobs = await Promise.all(
      Array.from({ length: 4 }, () => sprayDetectionMutations.requestSprayWallDetection({}, { input }, owner)),
    );
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    await expect(
      sprayDetectionQueries.sprayWallDetection({}, { id: jobs[0].id }, context(randomUUID())),
    ).rejects.toThrow();
    expect(await sprayDetectionQueries.sprayWallDetectionForVersion({}, input, owner)).toMatchObject({
      id: jobs[0].id,
      status: 'pending',
    });
  });
  it('fences a crashed attempt and does not insert or publish holds', async () => {
    const { owner, input } = await draft();
    const requested = await sprayDetectionMutations.requestSprayWallDetection({}, { input }, owner);
    const [record] = await db.select().from(sprayWallDetections).where(eq(sprayWallDetections.id, requested.id));
    const first = await claimSprayDetection(db, requested.id, record.jobId);
    const retry = await claimSprayDetection(db, requested.id, record.jobId);
    expect(first).not.toBeNull();
    expect(retry).not.toBeNull();
    expect(await finishSprayDetection(db, requested.id, first!.attemptToken, proposal)).toBe(false);
    expect(await finishSprayDetection(db, requested.id, retry!.attemptToken, proposal)).toBe(true);
    await retrySprayDetectionAttempt(db, requested.id, first!.attemptToken);
    expect(await sprayDetectionQueries.sprayWallDetection({}, { id: requested.id }, owner)).toMatchObject({
      status: 'done',
      result: proposal,
    });
    const [wall] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, input.wallUuid));
    expect(wall.currentVersionId).toBeNull();
  });
  it('discards completion when a draft is no longer current', async () => {
    const { owner, input } = await draft();
    const requested = await sprayDetectionMutations.requestSprayWallDetection({}, { input }, owner);
    const [record] = await db.select().from(sprayWallDetections).where(eq(sprayWallDetections.id, requested.id));
    const attempt = await claimSprayDetection(db, requested.id, record.jobId);
    await db
      .update(sprayWallVersions)
      .set({ status: 'published' })
      .where(eq(sprayWallVersions.id, Number(input.versionId)));
    expect(await finishSprayDetection(db, requested.id, attempt!.attemptToken, proposal)).toBe(false);
    expect(await sprayDetectionQueries.sprayWallDetection({}, { id: requested.id }, owner)).toMatchObject({
      status: 'cancelled',
      result: null,
    });
  });
  it('explicit retry creates one new job, even when the response is lost', async () => {
    const { owner, input } = await draft();
    const requested = await sprayDetectionMutations.requestSprayWallDetection({}, { input }, owner);
    await db.update(sprayWallDetections).set({ status: 'failed' }).where(eq(sprayWallDetections.id, requested.id));
    const retry = await sprayDetectionMutations.retrySprayWallDetection({}, { id: requested.id }, owner);
    const duplicate = await sprayDetectionMutations.retrySprayWallDetection({}, { id: requested.id }, owner);
    expect(retry.id).not.toBe(requested.id);
    expect(duplicate.id).toBe(retry.id);
  });
});
