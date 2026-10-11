import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SocialEvent } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import type { EventBroker } from '../events/event-broker';
import { NotificationWorker } from '../events/notification-worker';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';

// Production path: Redis Streams → NotificationWorker → createAndPublishNotification.
// The resolver tests run without a broker and only reach the inline fallback,
// which has no actor check, so the worker's follow_request exemption is pinned here.

const requester = 'fr-worker-requester';
const recipient = 'fr-worker-recipient';
const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `fr-worker-${userId}` }) as ConnectionContext;

/** The worker's consumer, captured the way production registers it, without Redis. */
function captureWorkerHandler(): (event: SocialEvent) => Promise<void> {
  let handler: ((event: SocialEvent) => Promise<void>) | undefined;
  const stubBroker = {
    startConsumer: (consume: (event: SocialEvent) => Promise<void>) => {
      handler = consume;
    },
  } as unknown as EventBroker;
  new NotificationWorker(stubBroker).start();
  if (!handler) throw new Error('NotificationWorker did not register a consumer');
  return handler;
}

const followRequested = (): SocialEvent => ({
  type: 'follow.requested',
  actorId: requester,
  entityType: 'user',
  entityId: requester,
  timestamp: Date.now(),
  metadata: { recipientUserId: recipient },
});

const followCreated = (metadata: Record<string, string> = {}): SocialEvent => ({
  type: 'follow.created',
  actorId: requester,
  entityType: 'user',
  entityId: recipient,
  timestamp: Date.now(),
  metadata: { followedUserId: recipient, ...metadata },
});

async function rowsOfType(type: dbSchema.NotificationType) {
  return db
    .select()
    .from(dbSchema.notifications)
    .where(and(eq(dbSchema.notifications.recipientId, recipient), eq(dbSchema.notifications.type, type)));
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE notifications, user_follow_requests, user_follows RESTART IDENTITY CASCADE`);
  await db
    .insert(dbSchema.users)
    .values([
      { id: requester, email: `${requester}@test.com`, name: 'Private asker' },
      { id: recipient, email: `${recipient}@test.com` },
    ])
    .onConflictDoNothing();
  // Both accounts private: without the exemption the recipient could not see
  // the requester's activity, and the worker would drop the row.
  await db
    .insert(dbSchema.userProfiles)
    .values([
      { userId: requester, isPrivate: true },
      { userId: recipient, isPrivate: true },
    ])
    .onConflictDoNothing();
  await db.insert(dbSchema.userFollowRequests).values({ requesterId: requester, recipientId: recipient });
});

describe('NotificationWorker follow requests', () => {
  it("writes the row even when the requester's own account is private, and only once per window", async () => {
    const handle = captureWorkerHandler();

    await handle(followRequested());
    const [row] = await rowsOfType('follow_request');
    expect(row).toMatchObject({ actorId: requester, entityId: requester, entityType: null, readAt: null });
    const inbox = await socialNotificationQueries.groupedNotifications(null, {}, context(recipient));
    expect(inbox.groups.map((group) => group.type)).toEqual(['follow_request']);

    await handle(followRequested());
    expect(await rowsOfType('follow_request')).toHaveLength(1);
  });

  it('writes one row when several workers handle the same request at once', async () => {
    // Two workers, as with several Redis consumers, each holding copies of the
    // event: a quick request, cancel, request. Without the per-pair lock both
    // could find no row and both insert.
    const workers = [captureWorkerHandler(), captureWorkerHandler()];
    await Promise.all(Array.from({ length: 6 }, (_, index) => workers[index % 2](followRequested())));

    expect(await rowsOfType('follow_request')).toHaveLength(1);
    expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(1);
  });

  it('replaces an older row after the window, so a later re-request is one unread row', async () => {
    const handle = captureWorkerHandler();
    await handle(followRequested());
    await db.execute(sql`
      UPDATE notifications SET created_at = now() - interval '2 days', read_at = now() - interval '2 days'
       WHERE type = 'follow_request'
    `);

    await handle(followRequested());

    const rows = await rowsOfType('follow_request');
    expect(rows).toHaveLength(1);
    expect(rows[0].readAt).toBeNull();
    expect(await socialNotificationQueries.unreadNotificationCount(null, null, context(recipient))).toBe(1);
  });

  it('tells nobody about a follow the owner just approved, but still announces a plain follow', async () => {
    const handle = captureWorkerHandler();

    await handle(followCreated({ fromFollowRequestApproval: 'true' }));
    expect(await rowsOfType('new_follower')).toEqual([]);

    await handle(followCreated());
    expect(await rowsOfType('new_follower')).toHaveLength(1);
  });
});
