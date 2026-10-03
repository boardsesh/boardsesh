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

  it('catches a finished model while the completion feed transaction is uncommitted', async () => {
    const target = await completedWall();
    const boss = await startJobQueue();
    await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
    let allowCompletionCommit!: () => void;
    let observeDevicesRead!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      allowCompletionCommit = resolve;
    });
    const devicesWereRead = new Promise<void>((resolve) => {
      observeDevicesRead = resolve;
    });
    // The worker has already selected zero devices, but its feed insert has not committed.
    const completion = db.transaction(async (transaction) => {
      await transaction.insert(notifications).values({
        uuid: target.detectionId,
        recipientId: target.ctx.userId!,
        type: 'spray_wall_detection_completed',
        entityType: 'board',
        entityId: target.wallUuid,
      });
      expect(
        await transaction.select().from(notificationDevices).where(eq(notificationDevices.userId, target.ctx.userId!)),
      ).toHaveLength(0);
      observeDevicesRead();
      await mayCommit;
    });
    const replay = vi.spyOn(boss, 'send');
    try {
      await Promise.race([devicesWereRead, completion]);
      expect(await db.select().from(notifications).where(eq(notifications.uuid, target.detectionId))).toHaveLength(0);
      expect(
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
        ),
      ).toBe(true);
      expect(replay).toHaveBeenCalledWith(
        SPRAY_DETECTION_COMPLETION_QUEUE,
        { detectionId: target.detectionId },
        expect.objectContaining({ retryLimit: 10 }),
      );
    } finally {
      allowCompletionCommit();
      await completion;
    }
    await notifySprayDetectionCompleted(boss, target.detectionId);
    await notifySprayDetectionCompleted(boss, target.detectionId);
    expect(await db.select().from(notifications).where(eq(notifications.uuid, target.detectionId))).toHaveLength(1);
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

  it('caps the device lease at the authenticated credential expiry and twenty-four hours', async () => {
    const target = await completedWall();
    const input = {
      installationId: randomUUID(),
      token: `ExpoPushToken[${randomUUID()}]`,
      platform: 'ios',
      locale: 'en-US',
    };
    const credentialExpiresAt = Date.now() + 5 * 60_000;
    await notificationDeviceMutations.registerNotificationDevice({}, { input }, { ...target.ctx, credentialExpiresAt });
    const [shortLease] = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.installationId, input.installationId));
    expect(shortLease.expiresAt.getTime()).toBe(credentialExpiresAt);

    const beforeRefresh = Date.now();
    await notificationDeviceMutations.registerNotificationDevice(
      {},
      { input },
      { ...target.ctx, credentialExpiresAt: beforeRefresh + 7 * 24 * 60 * 60_000 },
    );
    const [boundedLease] = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.installationId, input.installationId));
    expect(boundedLease.expiresAt.getTime()).toBeGreaterThanOrEqual(beforeRefresh + 24 * 60 * 60_000);
    expect(boundedLease.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);

    await expect(
      notificationDeviceMutations.registerNotificationDevice(
        {},
        { input },
        { ...target.ctx, credentialExpiresAt: Date.now() - 1 },
      ),
    ).rejects.toThrow('Authentication required');
    const [unchanged] = await db
      .select()
      .from(notificationDevices)
      .where(eq(notificationDevices.installationId, input.installationId));
    expect(unchanged.expiresAt).toEqual(boundedLease.expiresAt);
  });

  it.each(['before completion', 'after queue'])('does not deliver an expired device lease %s', async (expiryStage) => {
    const target = await completedWall();
    const installationId = randomUUID();
    await notificationDeviceMutations.registerNotificationDevice(
      {},
      { input: { installationId, token: `ExpoPushToken[${randomUUID()}]`, platform: 'ios', locale: 'en-US' } },
      target.ctx,
    );
    await finishSprayDetection(db, target.detectionId, target.attemptToken, proposal);
    const boss = await startJobQueue();
    if (expiryStage === 'before completion') {
      await db
        .update(notificationDevices)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(notificationDevices.installationId, installationId));
    }
    await notifySprayDetectionCompleted(boss, target.detectionId);
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationUuid, target.detectionId));
    if (expiryStage === 'before completion') {
      expect(deliveries).toHaveLength(0);
      return;
    }
    expect(deliveries).toHaveLength(1);
    await db
      .update(notificationDevices)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(notificationDevices.installationId, installationId));
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    await deliverSprayNotification(boss, deliveries[0].id);
    expect(transport).not.toHaveBeenCalled();
    const [skipped] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveries[0].id));
    expect(skipped.status).toBe('skipped');
  });

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

  it('keeps a failed HTTP delivery pending and persists the successful retry ticket', async () => {
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
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary upstream failure', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { status: 'ok', id: 'http-retry-ticket' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', transport);

    await expect(deliverSprayNotification(boss, delivery.id)).rejects.toThrow('EXPO_PUSH_HTTP_FAILED');
    const [pending] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(pending).toMatchObject({ status: 'pending', ticketId: null });

    await deliverSprayNotification(boss, delivery.id);
    const retryDeliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationUuid, target.detectionId));
    expect(retryDeliveries).toHaveLength(1);
    expect(retryDeliveries[0]).toMatchObject({ id: delivery.id, status: 'receipt', ticketId: 'http-retry-ticket' });
    expect(transport).toHaveBeenCalledTimes(2);
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
