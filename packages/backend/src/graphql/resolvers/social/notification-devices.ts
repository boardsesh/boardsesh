import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SPRAY_DETECTION_COMPLETION_QUEUE, type ConnectionContext } from '@boardsesh/shared-schema';
import { notificationDevices, notifications, sprayWallDetections } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { enqueueOn, requireJobQueue } from '../../../services/job-queue';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';

const installationIdSchema = z.string().min(16).max(200);
const deviceSchema = z.object({
  installationId: installationIdSchema,
  token: z
    .string()
    .regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/)
    .max(200),
  platform: z.enum(['ios', 'android']),
  locale: z.enum(['en-US', 'es', 'fr', 'de']),
});

export const notificationDeviceMutations = {
  registerNotificationDevice: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'registerNotificationDevice');
    const device = validateInput(deviceSchema, input, 'input');
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${device.token}, 192704))`);
      // A reinstall can rotate its installation id while retaining its push token.
      await transaction
        .update(notificationDevices)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(notificationDevices.token, device.token),
            ne(notificationDevices.installationId, device.installationId),
          ),
        );
      await transaction
        .insert(notificationDevices)
        .values({ ...device, userId: ctx.userId! })
        .onConflictDoUpdate({
          target: notificationDevices.installationId,
          set: { ...device, userId: ctx.userId!, active: true, updatedAt: new Date() },
        });
      // Catch a model that finished before permission/token registration did.
      const recent = await transaction
        .select({ detectionId: sprayWallDetections.id })
        .from(sprayWallDetections)
        .innerJoin(notifications, eq(notifications.uuid, sprayWallDetections.id))
        .where(
          and(
            eq(sprayWallDetections.requestedBy, ctx.userId!),
            eq(sprayWallDetections.status, 'done'),
            eq(notifications.recipientId, ctx.userId!),
            gt(notifications.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(10);
      for (const detection of recent) {
        const jobId = await requireJobQueue().send(
          SPRAY_DETECTION_COMPLETION_QUEUE,
          { detectionId: detection.detectionId },
          { db: enqueueOn(transaction), retryLimit: 10, retryDelay: 30, retryBackoff: true },
        );
        if (!jobId) throw new Error('COMPLETION_ENQUEUE_FAILED');
      }
    });
    return true;
  },
  unregisterNotificationDevice: async (
    _: unknown,
    { installationId }: { installationId: string },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'unregisterNotificationDevice');
    const validated = validateInput(installationIdSchema, installationId, 'installationId');
    await db
      .update(notificationDevices)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(notificationDevices.installationId, validated), eq(notificationDevices.userId, ctx.userId!)));
    return true;
  },
};
