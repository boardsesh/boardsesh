import crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

/**
 * How long a follow request notification blocks another one from the same
 * requester. A request/cancel loop inside this window re-shows the existing
 * row (it is visible again while a request is pending) instead of adding one.
 */
const FOLLOW_REQUEST_DEDUP_MINUTES = 24 * 60;

/**
 * Delete every follow request notification from `requesterId` to `recipientId`.
 * A pair holds at most one row: the writer below calls this before inserting a
 * new one, and the paths that answer a request (approve, decline, a follow that
 * replaced it) call it so nothing is left to answer.
 */
export async function deleteFollowRequestNotifications(
  requesterId: string,
  recipientId: string,
  executor: Pick<typeof db, 'delete'> = db,
): Promise<void> {
  await executor
    .delete(dbSchema.notifications)
    .where(
      and(
        eq(dbSchema.notifications.type, 'follow_request'),
        eq(dbSchema.notifications.actorId, requesterId),
        eq(dbSchema.notifications.recipientId, recipientId),
      ),
    );
}

/**
 * Write the follow request row for one pair, or nothing when one was written
 * inside the dedup window. Returns the new row's uuid so the caller can publish
 * it, or null. The worker and the inline fallback both write through here.
 *
 * The check, the delete and the insert run in one transaction under an
 * advisory lock on the pair. Several Redis workers can hold two
 * `follow.requested` events for the same pair at once (a quick request, cancel,
 * request), and without the lock both could see no row and both insert. The
 * lock is transaction-scoped, so it is released on commit or rollback.
 */
export async function writeFollowRequestNotification(requesterId: string, recipientId: string): Promise<string | null> {
  if (requesterId === recipientId) return null;
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`follow_request:${requesterId}:${recipientId}`}))`,
    );
    const [recent] = await transaction
      .select({ id: dbSchema.notifications.id })
      .from(dbSchema.notifications)
      .where(
        and(
          eq(dbSchema.notifications.type, 'follow_request'),
          eq(dbSchema.notifications.actorId, requesterId),
          eq(dbSchema.notifications.recipientId, recipientId),
          sql`${dbSchema.notifications.createdAt} > NOW() - make_interval(mins => ${FOLLOW_REQUEST_DEDUP_MINUTES})`,
        ),
      )
      .limit(1);
    if (recent) return null;
    await deleteFollowRequestNotifications(requesterId, recipientId, transaction);
    const uuid = crypto.randomUUID();
    // entityId is the requester, so each request is its own inbox row.
    await transaction.insert(dbSchema.notifications).values({
      uuid,
      recipientId,
      actorId: requesterId,
      type: 'follow_request',
      entityType: null,
      entityId: requesterId,
    });
    return uuid;
  });
}
