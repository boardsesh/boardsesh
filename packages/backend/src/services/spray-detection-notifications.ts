import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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
  sprayWalls,
  sprayWallVersions,
  userBoards,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import { enqueueOn } from './job-queue';
import { NOTIFICATION_DELIVERY_LOCK_SEED } from './notification-locks';
import { requireBoardEditAccess } from '../graphql/resolvers/social/boards';
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

// i18n-keep notifications.push.sprayWallTitle
// i18n-keep notifications.push.sprayWallBody
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
    source.wall.hiddenAt ||
    // A draft on a published wall is a retired in-place reset: it can never be
    // published, so there is nothing to send the owner back to.
    source.wall.currentVersionId !== null
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
  const resetSource = alias(sprayWalls, 'reset_source_spray_wall');
  // Re-reads the version so a draft deleted since the source read sends nothing.
  const [versionNow] = await executor
    .select({ resetSourceUuid: resetSource.boardUuid })
    .from(sprayWallVersions)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallVersions.wallId))
    .leftJoin(resetSource, and(eq(resetSource.id, sprayWalls.resetFromWallId), isNull(resetSource.deletedAt)))
    .where(eq(sprayWallVersions.id, source.version.id));
  if (!versionNow) return null;
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
      sprayResetOfWallUuid: versionNow.resetSourceUuid,
      isRead: false,
      createdAt: (source.detection.finishedAt ?? new Date()).toISOString(),
    },
  };
}

export async function notifySprayDetectionCompleted(boss: PgBoss, detectionId: string): Promise<void> {
  // Cheap pre-check outside any lock; the send decision uses the locked re-read.
  if (!(await completionNotification(detectionId))) return;
  // The source and permissions rechecked under the wall lock decide what is sent.
  const event = await db.transaction(async (transaction) => {
    const source = await readSprayDetection(transaction, detectionId);
    if (!source) return null;
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${source.wall.id})`);
    const current = await completionNotification(detectionId, transaction);
    if (!current) return null;
    const feedRow = await transaction
      .insert(notifications)
      .values({
        uuid: detectionId,
        recipientId: current.recipientId,
        type: 'spray_wall_detection_completed',
        entityType: 'board',
        entityId: current.notification.entityId,
        createdAt: new Date(current.notification.createdAt),
      })
      .onConflictDoNothing()
      .returning({ uuid: notifications.uuid });
    const devices = await transaction
      .select()
      .from(notificationDevices)
      .where(
        and(
          eq(notificationDevices.userId, current.recipientId),
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
          recipientId: current.recipientId,
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
    // A replay (registration catch-up, pg-boss retry) only adds deliveries for
    // new devices; the feed already holds this entry, so it is not republished.
    return feedRow.length > 0 ? current : null;
  });
  if (event) pubsub.publishNotificationEvent(event.recipientId, { notification: event.notification });
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
    // Recheck the target in its own short transaction. The wall lock orders this
    // read after any wall write in flight (revoke, hide, discard) and is released
    // before the Expo call below, so a slow push never stalls wall edits. Only
    // this delivery's lock is held across the HTTP request.
    const target = await db.transaction(async (validation) => {
      const source = await readSprayDetection(validation, delivery.notificationUuid);
      if (source)
        await validation.execute(
          sql`SELECT pg_advisory_xact_lock(${SPRAY_WALL_WRITE_LOCK_NAMESPACE}, ${source.wall.id})`,
        );
      const [device] = await validation
        .select({ installationId: notificationDevices.installationId })
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
        .limit(1);
      const current = await completionNotification(delivery.notificationUuid, validation);
      return device && current?.recipientId === delivery.recipientId ? current : null;
    });
    const setStatus = (status: typeof notificationDeliveries.$inferSelect.status, ticketId?: string | null) =>
      transaction
        .update(notificationDeliveries)
        .set({ status, ...(ticketId !== undefined ? { ticketId } : {}), updatedAt: new Date() })
        .where(eq(notificationDeliveries.id, delivery.id));
    if (!target) {
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
          ...sprayCompletionCopy(delivery.locale, target.notification.sprayWallName),
          data: {
            type: 'spray_wall_detection_completed',
            notificationUuid: delivery.notificationUuid,
            wallUuid: target.notification.sprayWallUuid,
            versionId: target.notification.sprayVersionId,
            resetOfWallUuid: target.notification.sprayResetOfWallUuid ?? null,
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
      // Only a payload problem is permanent. InvalidCredentials (APNs/FCM keys
      // revoked or mid-rotation) falls through to the retry below, so the
      // delivery lands once operators upload working credentials.
      if (ticket.details?.error === 'MessageTooBig') {
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
