import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { privacyMutations, RESOURCE_ACCESS_REQUESTS_PER_DAY } from '../graphql/resolvers/privacy';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';

// Asking to climb on an Invite-only board (docs/product/privacy.md, "Asking to
// climb"): who is told, when nobody is, and what decline and cancel undo.
// Real Postgres: the inbox rule is SQL.

const owner = 'access-owner';
const climber = 'access-climber';
const member = 'access-member';
const removed = 'access-removed';
const stranger = 'access-stranger';
const busy = 'access-busy';
const mixed = 'access-mixed';
const follower = 'access-follower';
const quietOwner = 'access-quiet-owner';
const newOwner = 'access-new-owner';
const offline = 'access-offline';

const context = (userId: string) =>
  ({ isAuthenticated: true, userId, connectionId: `access-${userId}-${Math.random()}` }) as ConnectionContext;

let boardSerial = 0;
async function seedBoard(
  ownerId = owner,
  audience: 'public' | 'unlisted' | 'followers' | 'invite_only' = 'invite_only',
): Promise<string> {
  boardSerial += 1;
  const uuid = uuidv4();
  await db.insert(schema.userBoards).values({
    uuid,
    slug: `access-board-${boardSerial}`,
    ownerId,
    name: `Garage ${boardSerial}`,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 200 + boardSerial,
    setIds: '1',
    isPublic: false,
    isUnlisted: false,
  });
  await db.insert(schema.resourcePrivacy).values({
    kind: 'board',
    resourceId: uuid,
    ownerId,
    audience,
    locationAudience: 'public',
  });
  return uuid;
}

async function setGrant(boardUuid: string, userId: string, status: 'pending' | 'approved' | 'revoked') {
  await db
    .insert(schema.resourceGrants)
    .values({ kind: 'board', resourceId: boardUuid, userId, status, invitedBy: owner })
    .onConflictDoUpdate({
      target: [schema.resourceGrants.kind, schema.resourceGrants.resourceId, schema.resourceGrants.userId],
      set: { status },
    });
}

async function grantOf(boardUuid: string, userId: string): Promise<string | null> {
  const [grant] = await db
    .select({ status: schema.resourceGrants.status })
    .from(schema.resourceGrants)
    .where(
      and(
        eq(schema.resourceGrants.kind, 'board'),
        eq(schema.resourceGrants.resourceId, boardUuid),
        eq(schema.resourceGrants.userId, userId),
      ),
    );
  return grant?.status ?? null;
}

/** Stored rows, whether or not the inbox would show them. */
async function storedNotices(
  recipientId: string,
  type: 'board_access_requested' | 'board_access_approved',
  boardUuid: string,
) {
  return db
    .select({ actorId: schema.notifications.actorId, entityType: schema.notifications.entityType })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.recipientId, recipientId),
        eq(schema.notifications.type, type),
        eq(schema.notifications.entityId, boardUuid),
      ),
    );
}

/** What the inbox shows for one board. */
async function inbox(viewerId: string, boardUuid: string) {
  const page = await socialNotificationQueries.groupedNotifications(null, { limit: 50 }, context(viewerId));
  return page.groups.filter((group) => group.entityId === boardUuid);
}

const request = (userId: string, boardUuid: string) =>
  privacyMutations.requestResourceAccess(null, { kind: 'board', resourceId: boardUuid }, context(userId));
const approve = (boardUuid: string, userId: string, asUser = owner) =>
  privacyMutations.approveResourceAccess(null, { kind: 'board', resourceId: boardUuid, userId }, context(asUser));
const decline = (boardUuid: string, userId: string, asUser = owner) =>
  privacyMutations.declineResourceAccess(null, { kind: 'board', resourceId: boardUuid, userId }, context(asUser));
const cancel = (userId: string, boardUuid: string) =>
  privacyMutations.cancelResourceAccessRequest(null, { kind: 'board', resourceId: boardUuid }, context(userId));
const unreadCount = (userId: string) => socialNotificationQueries.unreadNotificationCount(null, null, context(userId));

async function seedSession(): Promise<string> {
  const sessionId = uuidv4();
  await db.insert(schema.boardSessions).values({
    id: sessionId,
    boardPath: 'kilter/1/1/1/40',
    createdByUserId: owner,
    isPublic: true,
  });
  return sessionId;
}
const requestSession = (userId: string, sessionId: string) =>
  privacyMutations.requestResourceAccess(null, { kind: 'session', resourceId: sessionId }, context(userId));

/** A request notification written straight to the table, as a late writer would leave it. */
async function writeStoredRequestNotice(recipientId: string, actorId: string, boardUuid: string) {
  await db.insert(schema.notifications).values({
    uuid: uuidv4(),
    recipientId,
    actorId,
    type: 'board_access_requested',
    entityType: 'board',
    entityId: boardUuid,
  });
}

beforeAll(async () => {
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
  await db.insert(schema.users).values(
    [owner, climber, member, removed, stranger, busy, mixed, follower, quietOwner, newOwner, offline].map((id) => ({
      id,
      name: id,
      email: `${id}@test.invalid`,
    })),
  );
  await db.insert(schema.userProfiles).values({ userId: climber, displayName: 'Casey Crimper' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllEnvs());

describe('requestResourceAccess', () => {
  it("tells the board's owner once, naming the climber and the board", async () => {
    const board = await seedBoard();
    await expect(request(climber, board)).resolves.toBe(true);
    expect(await grantOf(board, climber)).toBe('pending');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([
      { actorId: climber, entityType: 'board' },
    ]);
    expect(await inbox(owner, board)).toMatchObject([
      {
        type: 'board_access_requested',
        entityType: 'board',
        entityId: board,
        boardType: 'kilter',
        actorCount: 1,
        actors: [{ id: climber, displayName: 'Casey Crimper' }],
        isRead: false,
      },
    ]);
  });

  it('does not tell the owner again while the request waits', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await request(climber, board);
    expect(await storedNotices(owner, 'board_access_requested', board)).toHaveLength(1);
    expect(await grantOf(board, climber)).toBe('pending');
  });

  it('keeps a removed climber removed, and the owner hears nothing', async () => {
    const board = await seedBoard();
    await setGrant(board, removed, 'revoked');
    await expect(request(removed, board)).resolves.toBe(true);
    expect(await grantOf(board, removed)).toBe('revoked');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
  });

  it('does nothing for a member', async () => {
    const board = await seedBoard();
    await setGrant(board, member, 'approved');
    await request(member, board);
    expect(await grantOf(board, member)).toBe('approved');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
  });

  it('sends no notification for a session request', async () => {
    const sessionId = uuidv4();
    await db.insert(schema.boardSessions).values({
      id: sessionId,
      boardPath: 'kilter/1/1/1/40',
      createdByUserId: owner,
      isPublic: true,
    });
    await privacyMutations.requestResourceAccess(null, { kind: 'session', resourceId: sessionId }, context(climber));
    const rows = await db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(eq(schema.notifications.entityId, sessionId));
    expect(rows).toEqual([]);
  });

  it('caps a climber at 5 asks a day across boards, not per minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Mid-day UTC, so the hours below stay inside one daily bucket.
    vi.setSystemTime(new Date('2026-11-25T08:00:00Z'));
    const boards = await Promise.all(Array.from({ length: RESOURCE_ACCESS_REQUESTS_PER_DAY + 1 }, () => seedBoard()));
    for (const board of boards.slice(0, RESOURCE_ACCESS_REQUESTS_PER_DAY)) await request(busy, board);

    const last = boards[RESOURCE_ACCESS_REQUESTS_PER_DAY];
    await expect(request(busy, last)).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', operation: 'requestResourceAccessDaily' },
    });
    // Well past the one-minute privacy limit: still capped for the day.
    vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
    const rejected = await request(busy, last).catch((error: { extensions: { retryAfterSeconds: number } }) => error);
    expect(rejected).toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
    expect((rejected as { extensions: { retryAfterSeconds: number } }).extensions.retryAfterSeconds).toBeGreaterThan(
      60 * 60,
    );
    expect(await grantOf(last, busy)).toBeNull();
    expect(await storedNotices(owner, 'board_access_requested', last)).toEqual([]);

    // A day later the climber can ask again.
    vi.setSystemTime(new Date('2026-11-26T08:01:00Z'));
    await expect(request(busy, last)).resolves.toBe(true);
    expect(await grantOf(last, busy)).toBe('pending');
  });
});

describe('requestResourceAccess on a board the climber can already open', () => {
  it.each(['public', 'unlisted'] as const)('writes nothing and tells nobody on a %s board', async (audience) => {
    const board = await seedBoard(owner, audience);
    await expect(request(climber, board)).resolves.toBe(true);
    expect(await grantOf(board, climber)).toBeNull();
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
  });

  it("writes nothing for a follower on a Followers board, but a stranger's ask still goes through", async () => {
    const board = await seedBoard(owner, 'followers');
    await db.insert(schema.userFollows).values({ followerId: follower, followingId: owner });
    await expect(request(follower, board)).resolves.toBe(true);
    expect(await grantOf(board, follower)).toBeNull();
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);

    await expect(request(stranger, board)).resolves.toBe(true);
    expect(await grantOf(board, stranger)).toBe('pending');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([
      { actorId: stranger, entityType: 'board' },
    ]);
  });

  it("writes nothing on the owner's own board", async () => {
    const board = await seedBoard();
    await expect(request(owner, board)).resolves.toBe(true);
    expect(await grantOf(board, owner)).toBeNull();
  });
});

describe('the daily ask cap', () => {
  it('counts board asks only: session join requests neither spend nor need the board budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T08:00:00Z'));
    // More session asks than the board cap allows: none of them count.
    for (let index = 0; index <= RESOURCE_ACCESS_REQUESTS_PER_DAY; index += 1)
      await expect(requestSession(mixed, await seedSession())).resolves.toBe(true);

    const boards = await Promise.all(Array.from({ length: RESOURCE_ACCESS_REQUESTS_PER_DAY + 1 }, () => seedBoard()));
    for (const board of boards.slice(0, RESOURCE_ACCESS_REQUESTS_PER_DAY))
      await expect(request(mixed, board)).resolves.toBe(true);
    await expect(request(mixed, boards[RESOURCE_ACCESS_REQUESTS_PER_DAY])).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', operation: 'requestResourceAccessDaily' },
    });

    // The board cap is spent; asking to join a session still works.
    const sessionId = await seedSession();
    await expect(requestSession(mixed, sessionId)).resolves.toBe(true);
    const [sessionGrant] = await db
      .select({ status: schema.resourceGrants.status })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.kind, 'session'),
          eq(schema.resourceGrants.resourceId, sessionId),
          eq(schema.resourceGrants.userId, mixed),
        ),
      );
    expect(sessionGrant?.status).toBe('pending');
  });

  it('holds on the in-memory tier alone while Redis is down, until midnight UTC', async () => {
    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-28T21:00:00Z'));
    const asker = offline;
    const boards = await Promise.all(Array.from({ length: RESOURCE_ACCESS_REQUESTS_PER_DAY + 1 }, () => seedBoard()));
    for (const board of boards.slice(0, RESOURCE_ACCESS_REQUESTS_PER_DAY)) await request(asker, board);

    const last = boards[RESOURCE_ACCESS_REQUESTS_PER_DAY];
    // Three hours to midnight UTC, the same answer the Redis tier would give.
    await expect(request(asker, last)).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 3 * 60 * 60 },
    });
    // The bucket is the UTC day, not 24 hours from the first ask.
    vi.setSystemTime(new Date('2026-11-29T00:00:01Z'));
    await expect(request(asker, last)).resolves.toBe(true);
    expect(await grantOf(last, asker)).toBe('pending');
  });
});

describe('approveResourceAccess', () => {
  it('tells the climber and clears the request from the owner', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await expect(approve(board, climber)).resolves.toBe(true);

    expect(await grantOf(board, climber)).toBe('approved');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
    expect(await storedNotices(climber, 'board_access_approved', board)).toEqual([
      { actorId: owner, entityType: 'board' },
    ]);
    expect(await inbox(climber, board)).toMatchObject([
      { type: 'board_access_approved', entityId: board, boardType: 'kilter', actors: [{ id: owner }] },
    ]);
    expect(await inbox(owner, board)).toEqual([]);
  });

  it('tells nobody when there was no waiting request', async () => {
    const board = await seedBoard();
    await approve(board, stranger);
    expect(await grantOf(board, stranger)).toBeNull();
    expect(await storedNotices(stranger, 'board_access_approved', board)).toEqual([]);
  });

  it("hides the climber's yes once the owner removes them", async () => {
    const board = await seedBoard();
    await request(climber, board);
    await approve(board, climber);
    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'board', resourceId: board, userId: climber },
      context(owner),
    );
    expect(await inbox(climber, board)).toEqual([]);
  });

  it('is owner-only', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await expect(approve(board, climber, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await grantOf(board, climber)).toBe('pending');
    expect(await storedNotices(climber, 'board_access_approved', board)).toEqual([]);
  });
});

describe('declineResourceAccess', () => {
  it('deletes the waiting request and its notification, and the climber can ask again', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await expect(decline(board, climber)).resolves.toBe(true);
    expect(await grantOf(board, climber)).toBeNull();
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
    expect(await storedNotices(climber, 'board_access_approved', board)).toEqual([]);

    await request(climber, board);
    expect(await grantOf(board, climber)).toBe('pending');
    expect(await inbox(owner, board)).toMatchObject([{ type: 'board_access_requested', actors: [{ id: climber }] }]);
  });

  it("leaves a member's and a removed climber's grant alone", async () => {
    const board = await seedBoard();
    await setGrant(board, member, 'approved');
    await setGrant(board, removed, 'revoked');
    await expect(decline(board, member)).resolves.toBe(false);
    await expect(decline(board, removed)).resolves.toBe(false);
    expect(await grantOf(board, member)).toBe('approved');
    expect(await grantOf(board, removed)).toBe('revoked');
  });

  it('is owner-only', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await expect(decline(board, climber, stranger)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    // The climber cannot answer their own request either.
    await expect(decline(board, climber, climber)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await grantOf(board, climber)).toBe('pending');
    expect(await storedNotices(owner, 'board_access_requested', board)).toHaveLength(1);
  });
});

describe('cancelResourceAccessRequest', () => {
  it('takes back a waiting request and its notification', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await expect(cancel(climber, board)).resolves.toBe(true);
    expect(await grantOf(board, climber)).toBeNull();
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
    expect(await inbox(owner, board)).toEqual([]);
  });

  it("only touches the caller's own waiting request", async () => {
    const board = await seedBoard();
    await request(climber, board);
    await setGrant(board, member, 'approved');
    await setGrant(board, removed, 'revoked');
    await expect(cancel(member, board)).resolves.toBe(false);
    await expect(cancel(removed, board)).resolves.toBe(false);
    await expect(cancel(stranger, board)).resolves.toBe(false);
    expect(await grantOf(board, climber)).toBe('pending');
    expect(await grantOf(board, member)).toBe('approved');
    expect(await grantOf(board, removed)).toBe('revoked');
    expect(await storedNotices(owner, 'board_access_requested', board)).toHaveLength(1);
  });
});

describe('answering a request by removing or inviting', () => {
  it('removing a waiting climber deletes the request notification', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'board', resourceId: board, userId: climber },
      context(owner),
    );
    expect(await grantOf(board, climber)).toBe('revoked');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
  });

  it('inviting a waiting climber by name deletes the request notification', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await privacyMutations.inviteResourceMember(
      null,
      { kind: 'board', resourceId: board, userId: climber },
      context(owner),
    );
    expect(await grantOf(board, climber)).toBe('approved');
    expect(await storedNotices(owner, 'board_access_requested', board)).toEqual([]);
  });
});

describe("the owner's inbox", () => {
  it('shows a request only while it waits', async () => {
    const board = await seedBoard();
    await request(climber, board);
    expect(await inbox(owner, board)).toHaveLength(1);
    // Removing the climber answers the request. A row written late, after the
    // removal committed, stays out of the inbox too.
    await privacyMutations.revokeResourceAccess(
      null,
      { kind: 'board', resourceId: board, userId: climber },
      context(owner),
    );
    await writeStoredRequestNotice(owner, climber, board);
    expect(await storedNotices(owner, 'board_access_requested', board)).toHaveLength(1);
    expect(await inbox(owner, board)).toEqual([]);
  });

  it('groups several climbers asking about one board into one row', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await request(stranger, board);
    const [group] = await inbox(owner, board);
    expect(group).toMatchObject({ type: 'board_access_requested', actorCount: 2 });
    expect(group.actors.map((actor) => actor.id).sort()).toEqual([climber, stranger].sort());
  });

  it('hides a request notification written after the climber cancelled', async () => {
    const board = await seedBoard(quietOwner);
    await request(climber, board);
    await cancel(climber, board);
    const unreadBefore = await unreadCount(quietOwner);
    // The notifier checked the grant before the cancel committed, then wrote.
    await writeStoredRequestNotice(quietOwner, climber, board);
    expect(await storedNotices(quietOwner, 'board_access_requested', board)).toHaveLength(1);
    expect(await inbox(quietOwner, board)).toEqual([]);
    expect(await unreadCount(quietOwner)).toBe(unreadBefore);
  });

  it('counts a waiting request as unread', async () => {
    const board = await seedBoard(quietOwner);
    const unreadBefore = await unreadCount(quietOwner);
    await request(stranger, board);
    expect(await unreadCount(quietOwner)).toBe(unreadBefore + 1);
  });

  it('hides a request once the board is deleted', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await db.update(schema.userBoards).set({ deletedAt: new Date() }).where(eq(schema.userBoards.uuid, board));
    expect(await storedNotices(owner, 'board_access_requested', board)).toHaveLength(1);
    expect(await inbox(owner, board)).toEqual([]);
  });

  it('hides a request once the board is merged into another', async () => {
    const board = await seedBoard();
    const survivor = await seedBoard();
    await request(climber, board);
    await db.update(schema.userBoards).set({ mergedIntoBoardUuid: survivor }).where(eq(schema.userBoards.uuid, board));
    expect(await storedNotices(owner, 'board_access_requested', board)).toHaveLength(1);
    expect(await inbox(owner, board)).toEqual([]);
  });

  it('hides a request from the old owner once the board changes hands', async () => {
    const board = await seedBoard();
    await request(climber, board);
    await db.update(schema.userBoards).set({ ownerId: newOwner }).where(eq(schema.userBoards.uuid, board));
    expect(await inbox(owner, board)).toEqual([]);
  });
});
