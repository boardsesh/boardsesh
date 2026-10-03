import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import {
  SPRAY_DETECTION_COMPLETION_QUEUE,
  SPRAY_WALL_WRITE_LOCK_NAMESPACE,
  type Notification,
  type SprayDetectionJob,
} from '@boardsesh/shared-schema';
import { readSprayDetection, sprayDetectionSourceIsCurrent } from '@boardsesh/db/queries';
import {
  notificationDevices,
  notificationDeliveries,
  notifications,
  sprayWallVersions,
  userBoards,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import { enqueueOn } from './job-queue';
import { NOTIFICATION_DELIVERY_LOCK_SEED } from './notification-locks';
import { requireBoardEditAccess } from '../graphql/resolvers/social/boards';
import { sprayVersionIsReset } from '../graphql/resolvers/social/spray-notification-targets';
import { pubsub } from '../pubsub';
import english from '@boardsesh/i18n/locales/en-US/notifications.json';
import spanish from '@boardsesh/i18n/locales/es/notifications.json';
import french from '@boardsesh/i18n/locales/fr/notifications.json';
import german from '@boardsesh/i18n/locales/de/notifications.json';

export const NOTIFICATION_PUSH_QUEUE = 'notification-push-delivery';
const RETRIES = { retryLimit: 20, retryDelay: 60, retryBackoff: true, retryDelayMax: 300 } as const;
const ticketSchema = z.object({
  status: z.enum(['ok', 'error']),
  id: z.string().optional(),
  details: z.object({ error: z.string().optional() }).optional(),
});
const responseSchema = z.object({ data: z.unknown() });
const copySchema = z.object({ push: z.object({ sprayWallTitle: z.string(), sprayWallBody: z.string() }) });

export function sprayCompletionCopy(locale: string, wallName: string): { title: string; body: string } {
  const catalogs: Record<string, unknown> = { 'en-US': english, es: spanish, fr: french, de: german };
  const { push } = copySchema.parse(catalogs[locale] ?? english);
  return { title: push.sprayWallTitle, body: push.sprayWallBody.replaceAll('{{wall}}', wallName) };
}

export async function completionNotification(
  detectionId: string,
  executor: Parameters<typeof readSprayDetection>[0] = db,
): Promise<{ recipientId: string; notification: Notification & { sprayWallName: string } } | null> {
  const source = await readSprayDetection(executor, detectionId);
  if (
    !source ||
    source.detection.status !== 'done' ||
    !source.detection.requestedBy ||
    !sprayDetectionSourceIsCurrent(source) ||
    source.wall.hiddenAt
  )
    return null;
  const [board] = await executor.select().from(userBoards).where(eq(userBoards.uuid, source.wall.boardUuid)).limit(1);
  if (!board) return null;
  try {
    await requireBoardEditAccess(
      { connectionId: 'spray-completion', userId: source.detection.requestedBy, isAuthenticated: true },
      board,
      executor,
    );
  } catch {
    return null;
  }
  const [versionKind] = await executor
    .select({ isReset: sprayVersionIsReset(executor, source.wall.id, source.version.versionNumber) })
    .from(sprayWallVersions)
    .where(eq(sprayWallVersions.id, source.version.id));
  if (!versionKind) return null;
  return {
    recipientId: source.detection.requestedBy,
    notification: {
      uuid: detectionId,
      type: 'spray_wall_detection_completed',
      entityType: 'board',
      entityId: source.wall.boardUuid,
      sprayWallName: board.name,
      sprayWallUuid: source.wall.boardUuid,
      sprayVersionId: String(source.version.id),
      isSprayReset: versionKind.isReset,
      isRead: false,
      createdAt: (source.detection.finishedAt ?? new Date()).toISOString(),
    },
  };
}

export async function notifySprayDetectionCompleted(boss: PgBoss, detectionId: string): Promise<void> {
  const event = await completionNotification(detectionId);
  if (!event) return;
  let deliverable = false;
  await db.transaction(async (transaction) => {
    const source = await readSprayDetection(transaction, detectionId);
    if (!source) return;
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${source.wall.id})`);
    const current = await completionNotification(detectionId, transaction);
    if (!current) return;
    // Replace the optimistic read with the source and permissions rechecked under the wall lock.
    Object.assign(event, current);
    deliverable = true;
    await transaction
      .insert(notifications)
      .values({
        uuid: detectionId,
        recipientId: event.recipientId,
        type: 'spray_wall_detection_completed',
        entityType: 'board',
        entityId: event.notification.entityId,
        createdAt: new Date(event.notification.createdAt),
      })
      .onConflictDoNothing();
    const devices = await transaction
      .select()
      .from(notificationDevices)
      .where(
        and(
          eq(notificationDevices.userId, event.recipientId),
          eq(notificationDevices.active, true),
          gt(notificationDevices.expiresAt, new Date()),
        ),
      );
    for (const device of devices) {
      const deliveryId = randomUUID();
      const inserted = await transaction
        .insert(notificationDeliveries)
        .values({
          id: deliveryId,
          notificationUuid: detectionId,
          installationId: device.installationId,
          recipientId: event.recipientId,
          token: device.token,
          locale: device.locale,
        })
        .onConflictDoNothing()
        .returning({ id: notificationDeliveries.id });
      if (!inserted.length) continue;
      const jobId = await boss.send(
        NOTIFICATION_PUSH_QUEUE,
        { deliveryId },
        { ...RETRIES, db: enqueueOn(transaction) },
      );
      // Roll back the feed entry and every delivery together; the completion job retries the atomic enqueue.
      if (!jobId) throw new Error('PUSH_ENQUEUE_FAILED');
    }
  });
  // Replays may republish the same UUID; clients deduplicate by UUID.
  if (deliverable) pubsub.publishNotificationEvent(event.recipientId, { notification: event.notification });
}

async function expoPost(path: 'send' | 'getReceipts', payload: unknown): Promise<unknown> {
  const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('EXPO_PUSH_HTTP_FAILED');
  return responseSchema.parse(await response.json()).data;
}

export async function deliverSprayNotification(boss: PgBoss, deliveryId: string): Promise<void> {
  let retry = false;
  await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${deliveryId}, ${NOTIFICATION_DELIVERY_LOCK_SEED}))`,
    );
    const [delivery] = await transaction
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .limit(1);
    if (!delivery || delivery.status === 'done' || delivery.status === 'skipped') return;
    const source = await readSprayDetection(transaction, delivery.notificationUuid);
    if (source)
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${source.wall.id})`,
      );
    const [device] = await transaction
      .select()
      .from(notificationDevices)
      .where(
        and(
          eq(notificationDevices.installationId, delivery.installationId),
          eq(notificationDevices.userId, delivery.recipientId),
          eq(notificationDevices.token, delivery.token),
          eq(notificationDevices.active, true),
          gt(notificationDevices.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('update');
    const event = await completionNotification(delivery.notificationUuid, transaction);
    const setStatus = (status: typeof notificationDeliveries.$inferSelect.status, ticketId?: string | null) =>
      transaction
        .update(notificationDeliveries)
        .set({ status, ...(ticketId !== undefined ? { ticketId } : {}), updatedAt: new Date() })
        .where(eq(notificationDeliveries.id, delivery.id));
    if (!device || !event || event.recipientId !== delivery.recipientId) {
      await setStatus('skipped');
      return;
    }
    if (delivery.ticketId && Date.now() - delivery.updatedAt.getTime() < 15 * 60_000)
      throw new Error('PUSH_RECEIPT_NOT_READY');
    const payload = delivery.ticketId
      ? await expoPost('getReceipts', { ids: [delivery.ticketId] })
      : await expoPost('send', {
          to: delivery.token,
          sound: 'default',
          ...sprayCompletionCopy(delivery.locale, event.notification.sprayWallName),
          data: {
            type: 'spray_wall_detection_completed',
            notificationUuid: delivery.notificationUuid,
            wallUuid: event.notification.sprayWallUuid,
            versionId: event.notification.sprayVersionId,
            isReset: event.notification.isSprayReset,
          },
          collapseId: delivery.notificationUuid,
          tag: delivery.notificationUuid,
        });
    const ticket = delivery.ticketId
      ? ticketSchema.parse(z.record(z.string(), z.unknown()).parse(payload)[delivery.ticketId])
      : ticketSchema.parse(Array.isArray(payload) ? payload[0] : payload);
    if (ticket.status === 'error') {
      if (ticket.details?.error === 'DeviceNotRegistered') {
        await transaction
          .update(notificationDevices)
          .set({ active: false, updatedAt: new Date() })
          .where(
            and(
              eq(notificationDevices.installationId, delivery.installationId),
              eq(notificationDevices.token, delivery.token),
            ),
          );
        await setStatus('skipped');
        return;
      }
      if (['MessageTooBig', 'InvalidCredentials'].includes(ticket.details?.error ?? '')) {
        await setStatus('skipped');
        return;
      }
      await setStatus('pending', null);
      retry = true;
      return;
    }
    if (delivery.ticketId) {
      await setStatus('done');
      return;
    }
    if (!ticket.id) throw new Error('EXPO_PUSH_INVALID_TICKET');
    // Ticket persistence and receipt job insertion commit together.
    {
      await transaction
        .update(notificationDeliveries)
        .set({ status: 'receipt', ticketId: ticket.id, updatedAt: new Date() })
        .where(eq(notificationDeliveries.id, delivery.id));
      const queued = await boss.send(
        NOTIFICATION_PUSH_QUEUE,
        { deliveryId },
        { ...RETRIES, startAfter: 15 * 60, db: enqueueOn(transaction) },
      );
      if (!queued) throw new Error('RECEIPT_ENQUEUE_FAILED');
    }
  });
  // Commit the cleared ticket before pg-boss retries; throwing inside would restore the stale ticket.
  if (retry) throw new Error('EXPO_PUSH_RETRY');
}

export async function startSprayDetectionNotifications(boss: PgBoss): Promise<void> {
  await boss.work<SprayDetectionJob>(
    SPRAY_DETECTION_COMPLETION_QUEUE,
    { localConcurrency: 1, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await notifySprayDetectionCompleted(boss, job.data.detectionId);
    },
  );
  await boss.work<{ deliveryId: string }>(
    NOTIFICATION_PUSH_QUEUE,
    { localConcurrency: 1, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await deliverSprayNotification(boss, job.data.deliveryId);
    },
  );
}
