import { and, eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

/**
 * How long a follow request notification blocks another one from the same
 * requester. A request/cancel loop inside this window re-shows the existing
 * row (it is visible again while a request is pending) instead of adding one.
 * The worker and the inline fallback both use it.
 */
export const FOLLOW_REQUEST_DEDUP_MINUTES = 24 * 60;

/**
 * Delete every follow request notification from `requesterId` to `recipientId`.
 * A pair holds at most one row: the writers call this before inserting a new
 * one, and the paths that resolve a request (approve, decline, a follow that
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
