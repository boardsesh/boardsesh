import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Notification } from '@boardsesh/shared-schema';
import {
  appFeedback,
  appFeedbackMessages,
  notificationDeliveries,
  notificationDevices,
  notifications,
} from '@boardsesh/db/schema';
import english from '@boardsesh/i18n/locales/en-US/notifications.json';
import spanish from '@boardsesh/i18n/locales/es/notifications.json';
import french from '@boardsesh/i18n/locales/fr/notifications.json';
import german from '@boardsesh/i18n/locales/de/notifications.json';
import italian from '@boardsesh/i18n/locales/it/notifications.json';
import chinese from '@boardsesh/i18n/locales/zh-CN/notifications.json';
import { z } from 'zod';
import { db } from '../db/client';
import { enqueueOn, requireJobQueue } from './job-queue';
import { NOTIFICATION_PUSH_QUEUE, NOTIFICATION_PUSH_RETRIES } from './notification-push-options';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const pushCopySchema = z.object({ push: z.object({ bugReportTitle: z.string(), bugReportBody: z.string() }) });

// i18n-keep notifications.push.bugReportTitle
// i18n-keep notifications.push.bugReportBody
export function feedbackReplyCopy(locale: string): { title: string; body: string } {
  const catalogs: Record<string, unknown> = {
    'en-US': english,
    es: spanish,
    fr: french,
    de: german,
    it: italian,
    'zh-CN': chinese,
  };
  const { push } = pushCopySchema.parse(catalogs[locale] ?? english);
  return { title: push.bugReportTitle, body: push.bugReportBody };
}

/** Revalidate report ownership for every push attempt, including receipt retries. */
export async function feedbackReplyTarget(notificationUuid: string, executor: Pick<typeof db, 'select'> = db) {
  const [target] = await executor
    .select({ reportId: appFeedback.id, recipientId: appFeedback.userId, createdAt: appFeedbackMessages.createdAt })
    .from(appFeedbackMessages)
    .innerJoin(appFeedback, eq(appFeedback.id, appFeedbackMessages.reportId))
    .innerJoin(notifications, eq(notifications.uuid, appFeedbackMessages.notificationUuid))
    .where(
      and(
        eq(appFeedbackMessages.notificationUuid, notificationUuid),
        eq(appFeedbackMessages.authorRole, 'staff'),
        isNull(appFeedbackMessages.withdrawnAt),
        eq(notifications.type, 'app_feedback_reply'),
        eq(notifications.recipientId, appFeedback.userId),
      ),
    )
    .limit(1);
  return target?.recipientId ? { ...target, recipientId: target.recipientId, reportId: String(target.reportId) } : null;
}

/** Caller commits message, inbox entry and delivery jobs in the same transaction. */
export async function enqueueFeedbackReply(
  transaction: Transaction,
  recipientId: string,
  message: typeof appFeedbackMessages.$inferSelect,
): Promise<Notification> {
  await transaction.insert(notifications).values({
    uuid: message.notificationUuid,
    recipientId,
    type: 'app_feedback_reply',
    entityId: String(message.reportId),
    createdAt: new Date(message.createdAt),
  });
  const devices = await transaction
    .select()
    .from(notificationDevices)
    .where(
      and(
        eq(notificationDevices.userId, recipientId),
        eq(notificationDevices.active, true),
        gt(notificationDevices.expiresAt, new Date()),
      ),
    );
  if (devices.length > 0) {
    const boss = requireJobQueue();
    for (const device of devices) {
      const deliveryId = randomUUID();
      await transaction.insert(notificationDeliveries).values({
        id: deliveryId,
        notificationUuid: message.notificationUuid,
        installationId: device.installationId,
        recipientId,
        token: device.token,
        locale: device.locale,
      });
      const jobId = await boss.send(
        NOTIFICATION_PUSH_QUEUE,
        { deliveryId },
        { ...NOTIFICATION_PUSH_RETRIES, db: enqueueOn(transaction) },
      );
      if (!jobId) throw new Error('PUSH_ENQUEUE_FAILED');
    }
  }
  return {
    uuid: message.notificationUuid,
    type: 'app_feedback_reply',
    entityId: String(message.reportId),
    createdAt: message.createdAt,
    isRead: false,
  };
}
