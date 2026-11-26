import crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { logger } from '../utils/logger';
import { enqueueRequestPush } from '../services/request-notification-push';

/**
 * The inbox rows for asking to climb on an Invite-only board
 * (docs/product/privacy.md, "Asking to climb"):
 *
 * - `board_access_requested`: to the board's owner. The actor is the climber
 *   who asked, the entity is the board. It shows only while that request is
 *   still waiting (`notificationPrivacyCondition`), and approve, decline and
 *   cancel delete it.
 * - `board_access_approved`: to the climber who asked. The actor is the owner,
 *   the entity is the board. It shows only while the climber is still a member.
 *
 * Both are written after the request or approval has committed (the callers
 * defer them with `deferDatabaseEffect`). Writing a notification takes a
 * key-share lock on both users rows through its foreign keys, and the resolvers
 * hold a board lock at that point, while owner privacy writers lock users rows
 * before boards: inside the transaction that order could deadlock.
 *
 * New pending requests also enqueue a push in the inbox transaction.
 * Approvals stay in-app only.
 */

type DeleteExecutor = Pick<typeof db, 'delete'>;
// ASCII BARQ: serialize notification writers for one board/requester pair.
const BOARD_ACCESS_NOTIFICATION_LOCK_NAMESPACE = 0x42415251;

/** Delete the owner's `board_access_requested` row for one climber's request on one board. */
export async function deleteBoardAccessRequestNotifications(
  executor: DeleteExecutor,
  requesterId: string,
  boardUuid: string,
): Promise<void> {
  await executor
    .delete(dbSchema.notifications)
    .where(
      and(
        eq(dbSchema.notifications.type, 'board_access_requested'),
        eq(dbSchema.notifications.actorId, requesterId),
        eq(dbSchema.notifications.entityType, 'board'),
        eq(dbSchema.notifications.entityId, boardUuid),
      ),
    );
}

async function grantStatus(boardUuid: string, userId: string): Promise<string | null> {
  const [grant] = await db
    .select({ status: dbSchema.resourceGrants.status })
    .from(dbSchema.resourceGrants)
    .where(
      and(
        eq(dbSchema.resourceGrants.kind, 'board'),
        eq(dbSchema.resourceGrants.resourceId, boardUuid),
        eq(dbSchema.resourceGrants.userId, userId),
      ),
    )
    .limit(1);
  return grant?.status ?? null;
}

async function actorCard(actorId: string) {
  const [actor] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, actorId))
    .limit(1);
  return {
    actorDisplayName: actor?.displayName || actor?.name || undefined,
    actorAvatarUrl: actor?.avatarUrl || actor?.image || undefined,
  };
}

/**
 * Store one inbox row, replacing an older row of the same kind for the same
 * pair and board, then publish it live. Returns the new row's uuid, or null
 * when the grant is no longer in `requiredStatus` (the request was cancelled or
 * answered before this ran), so a stale row is never written.
 */
async function writeBoardAccessNotification(input: {
  type: 'board_access_requested' | 'board_access_approved';
  recipientId: string;
  actorId: string;
  boardUuid: string;
  /** Whose grant on the board decides whether the row is still worth writing. */
  grantUserId: string;
  requiredStatus: 'pending' | 'approved';
}): Promise<string | null> {
  const { type, recipientId, actorId, boardUuid } = input;
  if (recipientId === actorId) return null;
  if ((await grantStatus(boardUuid, input.grantUserId)) !== input.requiredStatus) return null;
  const uuid = crypto.randomUUID();
  const written = await db.transaction(async (transaction) => {
    // Only notification writers take this lock; never hold the board lock
    // while inserting users' foreign keys (see the deferred-write rule above).
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${BOARD_ACCESS_NOTIFICATION_LOCK_NAMESPACE}, hashtext(${`${actorId}:${recipientId}:${boardUuid}:${type}`}))`,
    );
    const [currentGrant] = await transaction
      .select({ status: dbSchema.resourceGrants.status, createdAt: dbSchema.resourceGrants.createdAt })
      .from(dbSchema.resourceGrants)
      .where(
        and(
          eq(dbSchema.resourceGrants.kind, 'board'),
          eq(dbSchema.resourceGrants.resourceId, boardUuid),
          eq(dbSchema.resourceGrants.userId, input.grantUserId),
        ),
      )
      .limit(1);
    if (currentGrant?.status !== input.requiredStatus) return false;
    if (type === 'board_access_requested') {
      const [existing] = await transaction
        .select({ uuid: dbSchema.notifications.uuid, createdAt: dbSchema.notifications.createdAt })
        .from(dbSchema.notifications)
        .where(
          and(
            eq(dbSchema.notifications.type, type),
            eq(dbSchema.notifications.actorId, actorId),
            eq(dbSchema.notifications.recipientId, recipientId),
            eq(dbSchema.notifications.entityId, boardUuid),
          ),
        )
        .limit(1);
      if (existing && existing.createdAt >= currentGrant.createdAt) return false;
    }
    await transaction
      .delete(dbSchema.notifications)
      .where(
        and(
          eq(dbSchema.notifications.type, type),
          eq(dbSchema.notifications.actorId, actorId),
          eq(dbSchema.notifications.recipientId, recipientId),
          eq(dbSchema.notifications.entityType, 'board'),
          eq(dbSchema.notifications.entityId, boardUuid),
        ),
      );
    await transaction.insert(dbSchema.notifications).values({
      uuid,
      recipientId,
      actorId,
      type,
      entityType: 'board',
      entityId: boardUuid,
    });
    if (type === 'board_access_requested') await enqueueRequestPush(transaction, uuid, recipientId);
    return true;
  });
  if (!written) return null;
  pubsub.publishNotificationEvent(recipientId, {
    notification: {
      uuid,
      type,
      actorId,
      ...(await actorCard(actorId)),
      entityType: 'board',
      entityId: boardUuid,
      isRead: false,
      createdAt: new Date().toISOString(),
    },
  });
  return uuid;
}

/** Tell a board's owner that `requesterId` asked to climb on it. Best effort: a failure is logged. */
export async function notifyBoardAccessRequested(
  requesterId: string,
  ownerId: string,
  boardUuid: string,
): Promise<string | null> {
  try {
    return await writeBoardAccessNotification({
      type: 'board_access_requested',
      recipientId: ownerId,
      actorId: requesterId,
      boardUuid,
      grantUserId: requesterId,
      requiredStatus: 'pending',
    });
  } catch (error) {
    logger.error('[Privacy] board access request notification failed', { boardUuid, error });
    return null;
  }
}

/** Tell `requesterId` that the owner let them climb on the board. Best effort: a failure is logged. */
export async function notifyBoardAccessApproved(
  ownerId: string,
  requesterId: string,
  boardUuid: string,
): Promise<string | null> {
  try {
    return await writeBoardAccessNotification({
      type: 'board_access_approved',
      recipientId: requesterId,
      actorId: ownerId,
      boardUuid,
      grantUserId: requesterId,
      requiredStatus: 'approved',
    });
  } catch (error) {
    logger.error('[Privacy] board access approval notification failed', { boardUuid, error });
    return null;
  }
}
