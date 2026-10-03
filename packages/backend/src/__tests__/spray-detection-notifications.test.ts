import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { SPRAY_DETECTION_COMPLETION_QUEUE } from '@boardsesh/shared-schema';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import {
  notificationDevices,
  notificationDeliveries,
  notifications,
  sprayWallDetections,
  sprayWalls,
  sprayWallVersions,
  users,
} from '@boardsesh/db/schema';
import { finishSprayDetection } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { enqueueOn, startJobQueue, stopJobQueue } from '../services/job-queue';
import {
  completionNotification,
  deliverSprayNotification,
  notifySprayDetectionCompleted,
} from '../services/spray-detection-notifications';
import { notificationDeviceMutations } from '../graphql/resolvers/social/notification-devices';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));
const context = (userId: string): ConnectionContext => ({ userId, isAuthenticated: true, connectionId: userId });
const proposal = { width: 800, height: 600, candidates: [{ cx: 100, cy: 100, r: 10, confidence: 0.8 }] };

async function completedWall() {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: 'Import tester', email: `${userId}@example.test` });
  const ctx = context(userId);
  const wall = (await sprayWallMutations.createSprayWall({}, { input: { name: 'Waiting wall', angle: 40 } }, ctx)) as {
    uuid: string;
  };
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
  const detectionId = randomUUID();
  const attemptToken = randomUUID();
  await db.insert(sprayWallDetections).values({
    id: detectionId,
    wallId: source.id,
    versionId: version.id,
    requestedBy: userId,
    photoKey: version.photoKey!,
    photoWidth: 800,
    photoHeight: 600,
    modelVersion: 'test',
    weightsSha256: 'test',
    jobId: randomUUID(),
    status: 'running',
    attemptToken,
  });
  return { ctx, wallUuid: wall.uuid, versionId: version.id, detectionId, attemptToken };
}

describe('spray import completion notifications', () => {
  beforeAll(async () => {
    const client = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await initializeJobQueueSchema(drizzle(client));
    } finally {
      await client.end();
    }
    await startJobQueue();
  });
  afterAll(() => stopJobQueue());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rolls back the result if completion enqueue fails; stale fences never enqueue', async () => {
    const target = await completedWall();
    const enqueue = vi.fn().mockRejectedValue(new Error('queue failed'));
    await expect(finishSprayDetection(db, target.detectionId, target.attemptToken, proposal, enqueue)).rejects.toThrow(
      'queue failed',
    );
    const [record] = await db.select().from(sprayWallDetections).where(eq(sprayWallDetections.id, target.detectionId));
    expect(record.status).toBe('running');
    enqueue.mockClear();
    expect(await finishSprayDetection(db, target.detectionId, randomUUID(), proposal, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('commits one event and one feed entry, enriched without an actor', async () => {
    const target = await completedWall();
    const boss = await startJobQueue();
    let jobId: string | null = null;
    const enqueue = async (transaction: Parameters<typeof enqueueOn>[0]) => {
      jobId = await boss.send(
        SPRAY_DETECTION_COMPLETION_QUEUE,
        { detectionId: target.detectionId },
        { db: enqueueOn(transaction) },
      );
    };
    expect(await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal, enqueue)).toBe(true);
    expect(jobId).not.toBeNull();
    await notifySprayDetectionCompleted(boss, target.detectionId);
    await notifySprayDetectionCompleted(boss, target.detectionId);
    const feed = await socialNotificationQueries.groupedNotifications({}, {}, target.ctx);
    expect(feed.groups).toHaveLength(1);
    expect(feed.groups[0]).toMatchObject({
      uuid: target.detectionId,
      type: 'spray_wall_detection_completed',
      actorCount: 0,
      actors: [],
      sprayWallName: 'Waiting wall',
      sprayWallUuid: target.wallUuid,
      sprayVersionId: String(target.versionId),
      isSprayReset: false,
    });
    const directFeed = await socialNotificationQueries.notifications({}, {}, target.ctx);
    expect(directFeed.notifications[0]).toMatchObject({ sprayWallUuid: target.wallUuid });
  });

  it('does not notify published or changed-photo drafts', async () => {
    const target = await completedWall();
    await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
    await db
      .update(sprayWallVersions)
      .set({ photoKey: 'changed.jpg' })
      .where(eq(sprayWallVersions.id, target.versionId));
    expect(await completionNotification(target.detectionId)).toBeNull();
    await notifySprayDetectionCompleted(await startJobQueue(), target.detectionId);
    expect(await db.select().from(notifications).where(eq(notifications.uuid, target.detectionId))).toHaveLength(0);
  });

  it('switches installation ownership and prevents the previous account unregistering it', async () => {
    const first = await completedWall();
    const second = await completedWall();
    const installationId = randomUUID();
    const input = { installationId, token: `ExpoPushToken[${randomUUID()}]`, platform: 'ios', locale: 'fr' };
    await notificationDeviceMutations.registerNotificationDevice({}, { input }, first.ctx);
    await notificationDeviceMutations.registerNotificationDevice({}, { input }, second.ctx);
    await notificationDeviceMutations.unregisterNotificationDevice({}, { installationId }, first.ctx);
    const [registered] = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.installationId, installationId));
    expect(registered).toMatchObject({ userId: second.ctx.userId, active: true });
    const reinstallId = randomUUID();
    await notificationDeviceMutations.registerNotificationDevice(
      {},
      { input: { ...input, installationId: reinstallId } },
      second.ctx,
    );
    expect(
      await db
        .select()
        .from(notificationDevices)
        .where(and(eq(notificationDevices.token, input.token), eq(notificationDevices.active, true))),
    ).toHaveLength(1);
  });

  it('catches up a device registered after completion without duplicate deliveries', async () => {
    const target = await completedWall();
    const boss = await startJobQueue();
    await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
    await notifySprayDetectionCompleted(boss, target.detectionId);
    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationUuid, target.detectionId)),
    ).toHaveLength(0);
    await notificationDeviceMutations.registerNotificationDevice(
      {},
      {
        input: {
          installationId: randomUUID(),
          token: `ExpoPushToken[${randomUUID()}]`,
          platform: 'ios',
          locale: 'en-US',
        },
      },
      target.ctx,
    );
    await notifySprayDetectionCompleted(boss, target.detectionId);
    await notifySprayDetectionCompleted(boss, target.detectionId);
    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationUuid, target.detectionId)),
    ).toHaveLength(1);
  });

  it.each(['deduplicated', 'unavailable'])(
    'retains registration when catch-up is %s and recovers on refresh',
    async (mode) => {
      const previous = await completedWall();
      const target = await completedWall();
      const boss = await startJobQueue();
      const input = {
        installationId: randomUUID(),
        token: `ExpoPushToken[${randomUUID()}]`,
        platform: 'ios',
        locale: 'en-US',
      };
      await notificationDeviceMutations.registerNotificationDevice({}, { input }, previous.ctx);
      await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
      await notifySprayDetectionCompleted(boss, target.detectionId);
      const unavailableSend = vi.spyOn(boss, 'send');
      if (mode === 'deduplicated') unavailableSend.mockResolvedValueOnce(null);
      else unavailableSend.mockRejectedValueOnce(new Error('queue unavailable'));

      expect(await notificationDeviceMutations.registerNotificationDevice({}, { input }, target.ctx)).toBe(true);
      expect(unavailableSend).toHaveBeenCalledTimes(1);
      const [registered] = await db
        .select()
        .from(notificationDevices)
        .where(eq(notificationDevices.installationId, input.installationId));
      expect(registered).toMatchObject({ userId: target.ctx.userId, token: input.token, active: true });
      expect(await db.select().from(notifications).where(eq(notifications.uuid, target.detectionId))).toHaveLength(1);

      unavailableSend.mockRestore();
      const recoveredSend = vi.spyOn(boss, 'send');
      expect(await notificationDeviceMutations.registerNotificationDevice({}, { input }, target.ctx)).toBe(true);
      expect(recoveredSend).toHaveBeenCalledWith(
        SPRAY_DETECTION_COMPLETION_QUEUE,
        { detectionId: target.detectionId },
        expect.objectContaining({ retryLimit: 10 }),
      );
      await notifySprayDetectionCompleted(boss, target.detectionId);
      await notifySprayDetectionCompleted(boss, target.detectionId);
      expect(
        await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.notificationUuid, target.detectionId)),
      ).toHaveLength(1);
    },
  );

  it('serializes competing registrations for a token into one active account', async () => {
    const first = await completedWall();
    const second = await completedWall();
    const token = `ExpoPushToken[${randomUUID()}]`;
    await Promise.all(
      [first, second].map((target) =>
        notificationDeviceMutations.registerNotificationDevice(
          {},
          { input: { installationId: randomUUID(), token, platform: 'ios', locale: 'en-US' } },
          target.ctx,
        ),
      ),
    );
    expect(
      await db
        .select()
        .from(notificationDevices)
        .where(and(eq(notificationDevices.token, token), eq(notificationDevices.active, true))),
    ).toHaveLength(1);
  });

  it('commits clearing a failed receipt before requesting a retry', async () => {
    const target = await completedWall();
    await notificationDeviceMutations.registerNotificationDevice(
      {},
      {
        input: {
          installationId: randomUUID(),
          token: `ExpoPushToken[${randomUUID()}]`,
          platform: 'ios',
          locale: 'en-US',
        },
      },
      target.ctx,
    );
    await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
    const boss = await startJobQueue();
    await notifySprayDetectionCompleted(boss, target.detectionId);
    const [delivery] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationUuid, target.detectionId));
    await db
      .update(notificationDeliveries)
      .set({ status: 'receipt', ticketId: 'retry-ticket', updatedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(notificationDeliveries.id, delivery.id));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { 'retry-ticket': { status: 'error', details: { error: 'MessageRateExceeded' } } },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(deliverSprayNotification(boss, delivery.id)).rejects.toThrow('EXPO_PUSH_RETRY');
    const [retry] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(retry).toMatchObject({ status: 'pending', ticketId: null });
  });

  it('persists tickets, checks receipts, and retires invalid tokens', async () => {
    const target = await completedWall();
    await notificationDeviceMutations.registerNotificationDevice(
      {},
      {
        input: {
          installationId: randomUUID(),
          token: `ExpoPushToken[${randomUUID()}]`,
          platform: 'android',
          locale: 'en-US',
        },
      },
      target.ctx,
    );
    await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
    const boss = await startJobQueue();
    await notifySprayDetectionCompleted(boss, target.detectionId);
    const [delivery] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationUuid, target.detectionId));
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket-test' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', transport);
    const attempts = await Promise.allSettled([
      deliverSprayNotification(boss, delivery.id),
      deliverSprayNotification(boss, delivery.id),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const request = JSON.parse(transport.mock.calls[0][1].body as string) as {
      data: { wallUuid: string; versionId: string };
    };
    expect(request.data).toMatchObject({ wallUuid: target.wallUuid, versionId: String(target.versionId) });
    await db
      .update(notificationDeliveries)
      .set({ updatedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(notificationDeliveries.id, delivery.id));
    transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { 'ticket-test': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }),
        { status: 200 },
      ),
    );
    await deliverSprayNotification(boss, delivery.id);
    const [device] = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.installationId, delivery.installationId));
    expect(device.active).toBe(false);
    const [finished] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(finished.status).toBe('skipped');
  });
});
