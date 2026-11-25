import { count, gte, inArray, min } from 'drizzle-orm';
import { notificationDeliveries } from '@boardsesh/db/schema';
import { db, type Database } from '../db/client';
import { logger } from '../utils/logger';

const HOUR_MS = 60 * 60_000;
type DeliveryStatus = typeof notificationDeliveries.$inferSelect.status;

export type NotificationPushHealth = {
  updatedLast24h: Record<DeliveryStatus, number>;
  outstanding: { pending: number; receipt: number };
  oldestOutstandingUpdateAgeSeconds: number;
};

/** Status snapshots, not delivery transition counts; updatedAt changes on retries. */
export async function readNotificationPushHealth(
  database: Pick<Database, 'select'> = db,
  now = new Date(),
): Promise<NotificationPushHealth> {
  const recent = await database
    .select({ status: notificationDeliveries.status, count: count() })
    .from(notificationDeliveries)
    .where(gte(notificationDeliveries.updatedAt, new Date(now.getTime() - 24 * HOUR_MS)))
    .groupBy(notificationDeliveries.status);
  const outstandingRows = await database
    .select({
      status: notificationDeliveries.status,
      count: count(),
      oldestUpdate: min(notificationDeliveries.updatedAt),
    })
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.status, ['pending', 'receipt']))
    .groupBy(notificationDeliveries.status);
  const updatedLast24h = { pending: 0, receipt: 0, done: 0, skipped: 0 };
  for (const row of recent) updatedLast24h[row.status] = row.count;
  const outstanding = { pending: 0, receipt: 0 };
  let oldestOutstandingUpdateAgeSeconds = 0;
  for (const row of outstandingRows) {
    if (row.status !== 'pending' && row.status !== 'receipt') continue;
    outstanding[row.status] = row.count;
    if (row.oldestUpdate) {
      oldestOutstandingUpdateAgeSeconds = Math.max(
        oldestOutstandingUpdateAgeSeconds,
        Math.floor((now.getTime() - new Date(row.oldestUpdate).getTime()) / 1000),
      );
    }
  }
  return { updatedLast24h, outstanding, oldestOutstandingUpdateAgeSeconds };
}

/** The reconciliation queue calls this each minute; each process reports hourly. */
export function createNotificationPushHealthReporter(
  readSnapshot: (now: Date) => Promise<NotificationPushHealth> = (now) => readNotificationPushHealth(db, now),
  clock: () => number = Date.now,
): () => Promise<void> {
  let nextReportAt = 0;
  return async () => {
    const now = clock();
    if (now < nextReportAt) return;
    // Throttle failed reads too, without changing detection reconciliation.
    nextReportAt = now + HOUR_MS;
    try {
      const snapshot = await readSnapshot(new Date(now));
      logger.info('Expo push delivery health', { event: 'notification.push.health', ...snapshot });
      if (
        snapshot.outstanding.pending + snapshot.outstanding.receipt > 0 &&
        snapshot.oldestOutstandingUpdateAgeSeconds > 60 * 60 &&
        snapshot.updatedLast24h.done === 0
      ) {
        logger.error('Expo push delivery stalled', {
          event: 'notification.push.stalled',
          ...snapshot,
          error: new Error('PUSH_DELIVERY_STALLED'),
        });
      }
    } catch {
      logger.warn('Expo push health query failed', { event: 'notification.push.health_query_failed' });
    }
  };
}

export const reportNotificationPushHealth = createNotificationPushHealthReporter();
