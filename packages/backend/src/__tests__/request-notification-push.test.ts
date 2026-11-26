import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { writeFollowRequestNotification } from '../events/follow-request-notifications';
import { notifyBoardAccessRequested } from '../events/board-access-notifications';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { startJobQueue, stopJobQueue } from '../services/job-queue';
import { deliverSprayNotification } from '../services/spray-detection-notifications';
import { REQUEST_PUSHES_PER_DAY, requestPushCopy, requestPushTarget } from '../services/request-notification-push';

const context = (userId: string): ConnectionContext => ({ userId, isAuthenticated: true, connectionId: randomUUID() });

async function user(name = 'Kim') {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, name, email: `${id}@example.test` });
  return id;
}

async function owner(deviceCount = 1) {
  const recipientId = await user('Board owner');
  await db.insert(schema.userProfiles).values({ userId: recipientId, isPrivate: true });
  for (let index = 0; index < deviceCount; index += 1) {
    await db.insert(schema.notificationDevices).values({
      installationId: randomUUID(),
      userId: recipientId,
      token: `ExpoPushToken[${randomUUID()}]`,
      platform: 'ios',
      locale: 'en-US',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
  }
  return recipientId;
}

async function followRequest(recipientId: string, requester?: string) {
  const requesterId = requester ?? (await user());
  await db.insert(schema.userFollowRequests).values({ requesterId, recipientId }).onConflictDoNothing();
  const notificationUuid = await writeFollowRequestNotification(requesterId, recipientId);
  if (!notificationUuid) throw new Error('Expected a new follow request notice');
  return { recipientId, requesterId, notificationUuid };
}

async function board(recipientId: string) {
  const uuid = randomUUID();
  await db.insert(schema.userBoards).values({
    uuid,
    slug: `push-${uuid}`,
    ownerId: recipientId,
    name: 'Garage board',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    isPublic: false,
    isUnlisted: false,
  });
  await db.insert(schema.resourcePrivacy).values({
    kind: 'board',
    resourceId: uuid,
    ownerId: recipientId,
    audience: 'invite_only',
  });
  return uuid;
}

async function boardRequest(recipientId: string, requestedBoard?: string, requester?: string) {
  const boardUuid = requestedBoard ?? (await board(recipientId));
  const requesterId = requester ?? (await user());
  await db.insert(schema.resourceGrants).values({ kind: 'board', resourceId: boardUuid, userId: requesterId });
  const notificationUuid = await notifyBoardAccessRequested(requesterId, recipientId, boardUuid);
  if (!notificationUuid) throw new Error('Expected a new board request notice');
  return { recipientId, requesterId, boardUuid, notificationUuid };
}

const deliveries = (notificationUuid: string) =>
  db
    .select()
    .from(schema.notificationDeliveries)
    .where(eq(schema.notificationDeliveries.notificationUuid, notificationUuid));
const budgetFor = (recipientId: string) =>
  db
    .select()
    .from(schema.requestNotificationPushBudgets)
    .where(eq(schema.requestNotificationPushBudgets.recipientId, recipientId));

function expoSender() {
  const send = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok', id: randomUUID() }] }),
  });
  vi.stubGlobal('fetch', send);
  return send;
}

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await initializeJobQueueSchema(drizzle(client));
  } finally {
    await client.end();
  }
  await startJobQueue();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await stopJobQueue();
  vi.unstubAllEnvs();
});

describe('request push enqueue', () => {
  it('queues one follow push per live device, even for a private requester, and deduplicates pending repeats', async () => {
    const recipientId = await owner(2);
    const requesterId = await user();
    await db.insert(schema.userProfiles).values({ userId: requesterId, isPrivate: true });
    const request = await followRequest(recipientId, requesterId);
    const queued = await deliveries(request.notificationUuid);
    expect(queued).toHaveLength(2);
    expect(queued.every((delivery) => delivery.recipientId === recipientId && delivery.status === 'pending')).toBe(
      true,
    );
    expect(await writeFollowRequestNotification(requesterId, recipientId)).toBeNull();
    expect(await deliveries(request.notificationUuid)).toHaveLength(2);
    expect(await budgetFor(recipientId)).toMatchObject([{ count: 1 }]);
  });

  it('queues a new board request once through the real ask mutation', async () => {
    const recipientId = await owner();
    const requesterId = await user();
    const boardUuid = await board(recipientId);
    await privacyMutations.requestResourceAccess(null, { kind: 'board', resourceId: boardUuid }, context(requesterId));
    await privacyMutations.requestResourceAccess(null, { kind: 'board', resourceId: boardUuid }, context(requesterId));
    const notices = await db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.recipientId, recipientId),
          eq(schema.notifications.type, 'board_access_requested'),
          eq(schema.notifications.entityId, boardUuid),
        ),
      );
    expect(notices).toHaveLength(1);
    expect(await deliveries(notices[0].uuid)).toHaveLength(1);
    expect(await budgetFor(recipientId)).toMatchObject([{ count: 1 }]);
  });

  it('does not enqueue an unchanged pending request again after its notice ages past a day', async () => {
    const request = await followRequest(await owner());
    const requestedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const notifiedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await db
      .update(schema.userFollowRequests)
      .set({ createdAt: requestedAt })
      .where(
        and(
          eq(schema.userFollowRequests.requesterId, request.requesterId),
          eq(schema.userFollowRequests.recipientId, request.recipientId),
        ),
      );
    await db
      .update(schema.notifications)
      .set({ createdAt: notifiedAt })
      .where(eq(schema.notifications.uuid, request.notificationUuid));
    expect(await writeFollowRequestNotification(request.requesterId, request.recipientId)).toBeNull();
    expect(await deliveries(request.notificationUuid)).toHaveLength(1);
    expect(await budgetFor(request.recipientId)).toMatchObject([{ count: 1 }]);
  });

  it('rolls the inbox, budget and every device back when enqueue fails', async () => {
    const recipientId = await owner(2);
    const requesterId = await user();
    await db.insert(schema.userFollowRequests).values({ requesterId, recipientId });
    const boss = await startJobQueue();
    const send = vi.spyOn(boss, 'send').mockResolvedValueOnce(null);
    await expect(writeFollowRequestNotification(requesterId, recipientId)).rejects.toThrow('PUSH_ENQUEUE_FAILED');
    expect(send).toHaveBeenCalledOnce();
    expect(
      await db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, recipientId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.notificationDeliveries)
        .where(eq(schema.notificationDeliveries.recipientId, recipientId)),
    ).toEqual([]);
    expect(await budgetFor(recipientId)).toEqual([]);
    send.mockRestore();
    const notificationUuid = await writeFollowRequestNotification(requesterId, recipientId);
    expect(notificationUuid).not.toBeNull();
    expect(await budgetFor(recipientId)).toMatchObject([{ count: 1 }]);
  });

  it('shares a strict recipient cap across simultaneous follow and board requests', async () => {
    const recipientId = await owner();
    const requests = await Promise.all(
      Array.from({ length: REQUEST_PUSHES_PER_DAY + 4 }, async (_, index) =>
        index % 2 === 0 ? followRequest(recipientId) : boardRequest(recipientId),
      ),
    );
    const queued = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.recipientId, recipientId));
    expect(queued).toHaveLength(REQUEST_PUSHES_PER_DAY);
    expect(await budgetFor(recipientId)).toMatchObject([{ count: REQUEST_PUSHES_PER_DAY }]);
    expect(
      await db.select().from(schema.notifications).where(eq(schema.notifications.recipientId, recipientId)),
    ).toHaveLength(requests.length);
  });

  it('answering and deleting requests cannot buy extra pushes; the next UTC day resets the budget', async () => {
    const recipientId = await owner();
    await db.insert(schema.requestNotificationPushBudgets).values({
      recipientId,
      day: new Date().toISOString().slice(0, 10),
      count: REQUEST_PUSHES_PER_DAY - 1,
    });
    const last = await followRequest(recipientId);
    expect(await deliveries(last.notificationUuid)).toHaveLength(1);
    await privacyMutations.declineFollowRequest(null, { userId: last.requesterId }, context(recipientId));
    const capped = await boardRequest(recipientId);
    expect(await deliveries(capped.notificationUuid)).toEqual([]);
    await db
      .update(schema.requestNotificationPushBudgets)
      .set({ day: '2000-01-01' })
      .where(eq(schema.requestNotificationPushBudgets.recipientId, recipientId));
    const tomorrow = await followRequest(recipientId);
    expect(await deliveries(tomorrow.notificationUuid)).toHaveLength(1);
    expect(await budgetFor(recipientId)).toMatchObject([{ count: 1 }]);
  });

  it('does not spend the budget when no device can receive the push', async () => {
    const recipientId = await owner(0);
    const request = await followRequest(recipientId);
    expect(await deliveries(request.notificationUuid)).toEqual([]);
    expect(await budgetFor(recipientId)).toEqual([]);
  });
});

describe('request push delivery', () => {
  it.each(['follow_request', 'board_access_requested'] as const)(
    'sends %s with the actionable inbox UUID',
    async (type) => {
      const recipientId = await owner();
      const request = type === 'follow_request' ? await followRequest(recipientId) : await boardRequest(recipientId);
      const [delivery] = await deliveries(request.notificationUuid);
      const send = expoSender();
      await deliverSprayNotification(await startJobQueue(), delivery.id);
      expect(send).toHaveBeenCalledOnce();
      const payload = JSON.parse(send.mock.calls[0][1].body as string) as {
        to: string;
        title: string;
        body: string;
        data: { type: string; notificationUuid: string };
      };
      expect(payload).toMatchObject({
        to: delivery.token,
        data: { type, notificationUuid: request.notificationUuid },
      });
      expect(payload.body).toContain('Kim');
    },
  );

  it('does not send a follow push after the requester cancels', async () => {
    const request = await followRequest(await owner());
    const [delivery] = await deliveries(request.notificationUuid);
    await privacyMutations.cancelFollowRequest(null, { userId: request.recipientId }, context(request.requesterId));
    const send = expoSender();
    await deliverSprayNotification(await startJobQueue(), delivery.id);
    expect(send).not.toHaveBeenCalled();
    expect(await deliveries(request.notificationUuid)).toMatchObject([{ status: 'skipped' }]);
  });

  it('does not send the old follow push after cancel and a fresh ask within the dedup window', async () => {
    const request = await followRequest(await owner());
    const [delivery] = await deliveries(request.notificationUuid);
    await privacyMutations.cancelFollowRequest(null, { userId: request.recipientId }, context(request.requesterId));
    // Pin the two generations apart without sleeping on wall-clock precision.
    await db
      .update(schema.notifications)
      .set({ createdAt: new Date(Date.now() - 1000) })
      .where(eq(schema.notifications.uuid, request.notificationUuid));
    await privacyMutations.requestFollow(null, { userId: request.recipientId }, context(request.requesterId));
    expect(
      await socialNotificationQueries.requestNotification(
        null,
        { notificationUuid: request.notificationUuid },
        context(request.recipientId),
      ),
    ).toMatchObject({ uuid: request.notificationUuid });
    const send = expoSender();
    await deliverSprayNotification(await startJobQueue(), delivery.id);
    expect(send).not.toHaveBeenCalled();
    expect(await deliveries(request.notificationUuid)).toMatchObject([{ status: 'skipped' }]);
    expect(await budgetFor(request.recipientId)).toMatchObject([{ count: 1 }]);
  });

  it.each(['cancel', 'decline'] as const)('does not send a board push after %s', async (answer) => {
    const request = await boardRequest(await owner());
    const [delivery] = await deliveries(request.notificationUuid);
    if (answer === 'cancel') {
      await privacyMutations.cancelResourceAccessRequest(
        null,
        { kind: 'board', resourceId: request.boardUuid },
        context(request.requesterId),
      );
    } else {
      await privacyMutations.declineResourceAccess(
        null,
        { kind: 'board', resourceId: request.boardUuid, userId: request.requesterId },
        context(request.recipientId),
      );
    }
    const send = expoSender();
    await deliverSprayNotification(await startJobQueue(), delivery.id);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a stale board notice even if cancellation left its inbox row behind', async () => {
    const request = await boardRequest(await owner());
    const [delivery] = await deliveries(request.notificationUuid);
    await db
      .delete(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceId, request.boardUuid),
          eq(schema.resourceGrants.userId, request.requesterId),
        ),
      );
    expect(await requestPushTarget(request.notificationUuid)).toBeNull();
    const send = expoSender();
    await deliverSprayNotification(await startJobQueue(), delivery.id);
    expect(send).not.toHaveBeenCalled();
    expect(await deliveries(request.notificationUuid)).toMatchObject([{ status: 'skipped' }]);
  });

  it('rechecks the board and device lease before delivering', async () => {
    const request = await boardRequest(await owner());
    const [delivery] = await deliveries(request.notificationUuid);
    await db
      .update(schema.userBoards)
      .set({ deletedAt: new Date() })
      .where(eq(schema.userBoards.uuid, request.boardUuid));
    const send = expoSender();
    await deliverSprayNotification(await startJobQueue(), delivery.id);
    expect(send).not.toHaveBeenCalled();
    const follow = await followRequest(await owner());
    const [followDelivery] = await deliveries(follow.notificationUuid);
    await db
      .update(schema.notificationDevices)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.notificationDevices.installationId, followDelivery.installationId));
    await deliverSprayNotification(await startJobQueue(), followDelivery.id);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('request inbox push target', () => {
  it('returns the exact single asker even when other requests are grouped on that board', async () => {
    const recipientId = await owner();
    const boardUuid = await board(recipientId);
    const first = await boardRequest(recipientId, boardUuid);
    await boardRequest(recipientId, boardUuid);
    const result = await socialNotificationQueries.requestNotification(
      null,
      { notificationUuid: first.notificationUuid },
      context(recipientId),
    );
    expect(result).toMatchObject({
      uuid: first.notificationUuid,
      type: 'board_access_requested',
      entityId: boardUuid,
      actorCount: 1,
      actors: [{ id: first.requesterId, displayName: 'Kim' }],
    });
    expect(result?.actors).toHaveLength(1);
  });

  it('returns null to another user and after the request is no longer pending', async () => {
    const request = await followRequest(await owner());
    const read = (userId: string) =>
      socialNotificationQueries.requestNotification(
        null,
        { notificationUuid: request.notificationUuid },
        context(userId),
      );
    expect(await read(request.requesterId)).toBeNull();
    expect(await read(request.recipientId)).toMatchObject({ uuid: request.notificationUuid });
    await privacyMutations.cancelFollowRequest(null, { userId: request.recipientId }, context(request.requesterId));
    expect(await read(request.recipientId)).toBeNull();
  });
});

describe('request push translations', () => {
  it.each(['en-US', 'es', 'fr', 'de', 'it', 'zh-CN'])('words both pushes in %s with the requester name', (locale) => {
    for (const type of ['follow_request', 'board_access_requested'] as const) {
      const copy = requestPushCopy(locale, type, 'Kim');
      expect(copy.title).toBeTruthy();
      expect(copy.body).toContain('Kim');
      expect(copy.body).not.toContain('{{');
    }
  });
  it('falls back to English for an unknown device locale', () => {
    expect(requestPushCopy('unknown', 'follow_request', 'Kim')).toEqual(
      requestPushCopy('en-US', 'follow_request', 'Kim'),
    );
  });
});
