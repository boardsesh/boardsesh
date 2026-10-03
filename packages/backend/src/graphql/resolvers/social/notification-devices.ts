import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SPRAY_DETECTION_COMPLETION_QUEUE, type ConnectionContext } from '@boardsesh/shared-schema';
import { notificationDevices, sprayWallDetections } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireJobQueue } from '../../../services/job-queue';
import { logger } from '../../../utils/logger';
import { NOTIFICATION_DEVICE_TOKEN_LOCK_SEED } from '../../../services/notification-locks';
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
    const now = Date.now();
    const leaseLimit = now + 24 * 60 * 60_000;
    const expiresAt = new Date(Math.min(ctx.credentialExpiresAt ?? leaseLimit, leaseLimit));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) {
      requireAuthenticated({ ...ctx, isAuthenticated: false });
    }
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${device.token}, ${NOTIFICATION_DEVICE_TOKEN_LOCK_SEED}))`,
      );
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
        .values({ ...device, userId: ctx.userId!, expiresAt })
        .onConflictDoUpdate({
          target: notificationDevices.installationId,
          set: { ...device, userId: ctx.userId!, active: true, expiresAt, updatedAt: new Date() },
        });
    });
    // Register the device even when replaying an older completion cannot enqueue.
    // Foreground registration retries catch-up; future completions already see it.
    try {
      // A completion may have read devices before registration while its feed
      // insert is still uncommitted. Detection completion is already durable.
      const recent = await db
        .select({ detectionId: sprayWallDetections.id })
        .from(sprayWallDetections)
        .where(
          and(
            eq(sprayWallDetections.requestedBy, ctx.userId!),
            eq(sprayWallDetections.status, 'done'),
            gt(sprayWallDetections.finishedAt, new Date(Date.now() - 24 * 60 * 60_000)),
          ),
        )
        .orderBy(desc(sprayWallDetections.finishedAt))
        .limit(10);
      for (const detection of recent) {
        await requireJobQueue().send(
          SPRAY_DETECTION_COMPLETION_QUEUE,
          { detectionId: detection.detectionId },
          { retryLimit: 10, retryDelay: 30, retryBackoff: true },
        );
        // Catch-up is optional; a null send result must not undo registration.
      }
    } catch {
      logger.warn('[NotificationDevices] Completion catch-up unavailable; registration saved', {
        event: 'notification_catchup_unavailable',
      });
    }
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
