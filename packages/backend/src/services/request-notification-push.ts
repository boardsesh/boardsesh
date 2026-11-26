import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import {
  notificationDeliveries,
  notificationDevices,
  notifications,
  requestNotificationPushBudgets,
  users,
  userProfiles,
  userBoards,
  userFollowRequests,
  resourceGrants,
} from '@boardsesh/db/schema';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import english from '@boardsesh/i18n/locales/en-US/notifications.json';
import spanish from '@boardsesh/i18n/locales/es/notifications.json';
import french from '@boardsesh/i18n/locales/fr/notifications.json';
import german from '@boardsesh/i18n/locales/de/notifications.json';
import italian from '@boardsesh/i18n/locales/it/notifications.json';
import chinese from '@boardsesh/i18n/locales/zh-CN/notifications.json';
import { db } from '../db/client';
import { notificationPrivacyCondition } from '../graphql/resolvers/shared/activity-privacy';
import { enqueueOn, getJobQueue } from './job-queue';
import { NOTIFICATION_PUSH_QUEUE, NOTIFICATION_PUSH_RETRIES } from './notification-push-options';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const REQUEST_PUSHES_PER_DAY = 10;

/** Inbox row, budget, devices and jobs commit together. One request costs one, regardless of device count. */
export async function enqueueRequestPush(
  transaction: Transaction,
  notificationUuid: string,
  recipientId: string,
): Promise<void> {
  const boss = getJobQueue();
  if (!boss) return;
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
  if (devices.length === 0) return;
  // Atomic upsert serializes competing request types across replicas. Keep one
  // row per recipient, independent of inbox/deletion and device churn.
  const day = new Date().toISOString().slice(0, 10);
  const budget = requestNotificationPushBudgets;
  const claimed = await transaction
    .insert(budget)
    .values({ recipientId, day, count: 1 })
    .onConflictDoUpdate({
      target: budget.recipientId,
      set: { day, count: sql`CASE WHEN ${budget.day} = ${day}::date THEN ${budget.count} + 1 ELSE 1 END` },
      setWhere: sql`${budget.day} <> ${day}::date OR ${budget.count} < ${REQUEST_PUSHES_PER_DAY}`,
    })
    .returning({ recipientId: budget.recipientId });
  if (claimed.length === 0) return;
  for (const device of devices) {
    const deliveryId = randomUUID();
    await transaction.insert(notificationDeliveries).values({
      id: deliveryId,
      notificationUuid,
      installationId: device.installationId,
      recipientId,
      token: device.token,
      locale: device.locale,
    });
    const jobId = await boss.send(
      NOTIFICATION_PUSH_QUEUE,
      { deliveryId },
      {
        ...NOTIFICATION_PUSH_RETRIES,
        db: enqueueOn(transaction),
      },
    );
    if (!jobId) throw new Error('PUSH_ENQUEUE_FAILED');
  }
}

type RequestType = 'follow_request' | 'board_access_requested';
const catalogs: Record<string, typeof english> = {
  'en-US': english,
  es: spanish,
  fr: french,
  de: german,
  it: italian,
  'zh-CN': chinese,
};

// i18n-keep notifications.push.requestTitle
// i18n-keep notifications.push.requestAnonymous
// i18n-keep notifications.push.followRequestBody
// i18n-keep notifications.push.boardAccessRequestBody
export function requestPushCopy(locale: string, type: RequestType, actorName: string | null) {
  const { push } = catalogs[locale] ?? english;
  const template = type === 'follow_request' ? push.followRequestBody : push.boardAccessRequestBody;
  return { title: push.requestTitle, body: template.replaceAll('{{name}}', actorName || push.requestAnonymous) };
}

/** Same pending-state and ownership rules as the inbox, checked anew on every send attempt. */
export async function requestPushTarget(
  notificationUuid: string,
  executor: Pick<typeof db, 'select'> = db,
  matchGeneration = true,
) {
  const [notice] = await executor
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.uuid, notificationUuid),
        inArray(notifications.type, ['follow_request', 'board_access_requested']),
      ),
    )
    .limit(1);
  if (!notice) return null;
  const [target] = await executor
    .select({
      uuid: notifications.uuid,
      type: notifications.type,
      recipientId: notifications.recipientId,
      actorId: users.id,
      actorName: sql<string | null>`COALESCE(NULLIF(${userProfiles.displayName}, ''), ${users.name})`,
      actorAvatar: sql<string | null>`COALESCE(${userProfiles.avatarUrl}, ${users.image})`,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      boardType: userBoards.boardType,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(userBoards, and(eq(notifications.entityType, 'board'), eq(userBoards.uuid, notifications.entityId)))
    .leftJoin(
      userFollowRequests,
      and(
        eq(userFollowRequests.requesterId, notifications.actorId),
        eq(userFollowRequests.recipientId, notifications.recipientId),
      ),
    )
    .leftJoin(
      resourceGrants,
      and(
        eq(resourceGrants.kind, 'board'),
        eq(resourceGrants.resourceId, notifications.entityId),
        eq(resourceGrants.userId, notifications.actorId),
      ),
    )
    .where(
      and(
        eq(notifications.uuid, notificationUuid),
        eq(notifications.recipientId, notice.recipientId),
        notificationPrivacyCondition(notice.recipientId),
        // A cancelled request may be asked again while its old inbox row is
        // retained for dedup. That does not revive its queued phone alert.
        matchGeneration
          ? or(
              and(eq(notifications.type, 'follow_request'), lte(userFollowRequests.createdAt, notifications.createdAt)),
              and(
                eq(notifications.type, 'board_access_requested'),
                lte(resourceGrants.createdAt, notifications.createdAt),
              ),
            )
          : undefined,
      ),
    )
    .limit(1);
  if (!target || (target.type !== 'follow_request' && target.type !== 'board_access_requested')) return null;
  return { ...target, type: target.type };
}

export async function readRequestNotification(
  notificationUuid: string,
  recipientId: string,
): Promise<GroupedNotification | null> {
  const target = await requestPushTarget(notificationUuid, db, false);
  if (!target || target.recipientId !== recipientId) return null;
  return {
    uuid: target.uuid,
    type: target.type,
    entityType: target.entityType,
    entityId: target.entityId,
    actorCount: 1,
    actors: [{ id: target.actorId, displayName: target.actorName, avatarUrl: target.actorAvatar }],
    boardType: target.boardType,
    isRead: target.readAt !== null,
    createdAt: target.createdAt.toISOString(),
  };
}
