/**
 * Real-DB coverage for #6385: the owner of an item hears about every comment on
 * it, because since #6356 the owner reads every comment on it, whatever the
 * commenter's account privacy. A private commenter is named to the owner. A
 * proposal has no owner, but the setter of a reported climb is still told,
 * with no reporter named when they may not see the reporter's account.
 */
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { executeRows } from '@boardsesh/db/client';
import { entityOwnerCondition, entityOwnerIdsQuery } from '@boardsesh/db/queries';
import type { ConnectionContext, SocialEvent } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import type { EventBroker } from '../events/event-broker';
import { NotificationWorker } from '../events/notification-worker';
import { publishSocialEvent } from '../events';
import { socialCommentMutations } from '../graphql/resolvers/social/comments';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';

// Feed fan-out is not under test here; the notification rows are.
vi.mock('../events/feed-fanout', () => ({
  fanoutFeedItems: vi.fn(async () => {}),
  fanoutNewClimbFeedItems: vi.fn(async () => {}),
  fanoutCommentFeedItems: vi.fn(async () => {}),
  fanoutProposalApprovedFeedItems: vi.fn(async () => {}),
}));

const PREFIX = 'owner-comment';
const HOST = `${PREFIX}-host`;
const SETTER = `${PREFIX}-setter`;
const PLAYLIST_OWNER = `${PREFIX}-playlist-owner`;
const BOARD_OWNER = `${PREFIX}-board-owner`;
const GYM_OWNER = `${PREFIX}-gym-owner`;
const AURORA_SETTER = `${PREFIX}-aurora-setter`;
const PRIVATE_COMMENTER = `${PREFIX}-private-commenter`;
const PUBLIC_COMMENTER = `${PREFIX}-public-commenter`;
const STRANGER = `${PREFIX}-stranger`;
const ALL_USERS = [
  HOST,
  SETTER,
  PLAYLIST_OWNER,
  BOARD_OWNER,
  GYM_OWNER,
  AURORA_SETTER,
  PRIVATE_COMMENTER,
  PUBLIC_COMMENTER,
  STRANGER,
];

const SESSION_ID = `${PREFIX}-session`;
const CLIMB_UUID = `${PREFIX}-climb`;
const DRAFT_CLIMB_UUID = `${PREFIX}-draft-climb`;
const UNLISTED_CLIMB_UUID = `${PREFIX}-unlisted-climb`;
const AURORA_CLIMB_UUID = `${PREFIX}-aurora-climb`;
const CLIMB_NAME = 'Owner comment crimp line';
const PLAYLIST_UUID = randomUUID();
const BOARD_UUID = `${PREFIX}-board`;
const DELETED_BOARD_UUID = `${PREFIX}-deleted-board`;
const GYM_UUID = `${PREFIX}-gym`;
const GYM_NAME = 'Owner comment bouldering';
const AURORA_USER_ID = 616_385;
// The system catalogue account: owner of unclaimed synced gyms and handed-over walls.
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const UNCLAIMED_GYM_UUID = `${PREFIX}-unclaimed-gym`;
const SYSTEM_BOARD_UUID = `${PREFIX}-system-board`;
const SPRAY_BOARD_UUID = `${PREFIX}-spray-board`;
// The job account generated recommendation playlists belong to.
const RECOMMENDATIONS_OWNER = 'system-recommendations';
const RECOMMENDED_PLAYLIST_UUID = randomUUID();

const viewer = (userId: string): ConnectionContext =>
  ({ connectionId: `${PREFIX}-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

/** Drive the worker the way production does: `start()` hands its handler to the broker. */
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

type Commentable = { entityType: dbSchema.SocialEntityType; entityId: string };

/** Write a comment the way `addComment` stores it, and return its uuid. */
async function insertComment(item: Commentable, authorId: string, parentUuid?: string): Promise<string> {
  const uuid = randomUUID();
  let parentCommentId: number | null = null;
  if (parentUuid) {
    const [parent] = await db
      .select({ id: dbSchema.comments.id })
      .from(dbSchema.comments)
      .where(eq(dbSchema.comments.uuid, parentUuid));
    parentCommentId = parent.id;
  }
  await db.insert(dbSchema.comments).values({
    uuid,
    userId: authorId,
    entityType: item.entityType,
    entityId: item.entityId,
    parentCommentId,
    body: `Comment by ${authorId}`,
  });
  return uuid;
}

/** The event `addComment` publishes for that comment. */
function commentEvent(item: Commentable, authorId: string, commentUuid: string, parentUuid?: string): SocialEvent {
  return {
    type: parentUuid ? 'comment.reply' : 'comment.created',
    actorId: authorId,
    entityType: item.entityType,
    entityId: item.entityId,
    timestamp: Date.now(),
    metadata: { commentUuid, ...(parentUuid ? { parentCommentId: parentUuid } : {}) },
  };
}

/** Comment on an item and run the worker on the event, as production does. */
async function commentThroughWorker(item: Commentable, authorId: string, parentUuid?: string): Promise<string> {
  const commentUuid = await insertComment(item, authorId, parentUuid);
  await captureWorkerHandler()(commentEvent(item, authorId, commentUuid, parentUuid));
  return commentUuid;
}

type StoredNotification = { recipientId: string; actorId: string | null; type: string; commentId: number | null };

async function notificationsAbout(entityId: string): Promise<StoredNotification[]> {
  return db
    .select({
      recipientId: dbSchema.notifications.recipientId,
      actorId: dbSchema.notifications.actorId,
      type: dbSchema.notifications.type,
      commentId: dbSchema.notifications.commentId,
    })
    .from(dbSchema.notifications)
    .where(eq(dbSchema.notifications.entityId, entityId));
}

async function seedSession(): Promise<void> {
  // The harness clears sessions before every case, so each case that needs one seeds it.
  await db
    .insert(dbSchema.boardSessions)
    .values({ id: SESSION_ID, boardPath: 'kilter/1/1/1/40', createdByUserId: HOST, isPublic: true })
    .onConflictDoNothing();
}

beforeAll(async () => {
  await db.insert(dbSchema.users).values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: id })));
  await db.insert(dbSchema.userProfiles).values({ userId: PRIVATE_COMMENTER, isPrivate: true, privacyRevision: 1 });
  const climb = (uuid: string, overrides: Partial<typeof dbSchema.boardClimbs.$inferInsert> = {}) => ({
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    userId: SETTER,
    name: uuid === CLIMB_UUID ? CLIMB_NAME : uuid,
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
    ...overrides,
  });
  await db
    .insert(dbSchema.boardClimbs)
    .values([
      climb(CLIMB_UUID),
      climb(DRAFT_CLIMB_UUID, { isDraft: true }),
      climb(UNLISTED_CLIMB_UUID, { isListed: false }),
      climb(AURORA_CLIMB_UUID, { userId: null, setterId: AURORA_USER_ID }),
    ]);
  await db.execute(sql`
    INSERT INTO "aurora_credentials" (user_id, board_type, aurora_user_id, sync_status, created_at, updated_at)
    VALUES (${AURORA_SETTER}, 'kilter', ${AURORA_USER_ID}, 'active', now(), now())
  `);
  const [playlist] = await db
    .insert(dbSchema.playlists)
    .values({ uuid: PLAYLIST_UUID, boardType: 'kilter', name: 'Owner comment circuit', isPublic: true })
    .returning();
  await db
    .insert(dbSchema.playlistOwnership)
    .values({ playlistId: playlist.id, userId: PLAYLIST_OWNER, role: 'owner' });
  await db.insert(dbSchema.playlistClimbs).values({ playlistId: playlist.id, climbUuid: CLIMB_UUID, position: 0 });
  await db
    .insert(dbSchema.users)
    .values({ id: RECOMMENDATIONS_OWNER, email: 'recommendations@boardsesh.com', name: 'Boardsesh' })
    .onConflictDoNothing();
  const [recommended] = await db
    .insert(dbSchema.playlists)
    .values({ uuid: RECOMMENDED_PLAYLIST_UUID, boardType: 'kilter', name: 'Popular this week', isPublic: true })
    .returning();
  await db
    .insert(dbSchema.playlistOwnership)
    .values({ playlistId: recommended.id, userId: RECOMMENDATIONS_OWNER, role: 'owner' });
  await db.insert(dbSchema.userBoards).values(
    [BOARD_UUID, DELETED_BOARD_UUID].map((uuid, index) => ({
      uuid,
      slug: uuid,
      ownerId: BOARD_OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 20 + index,
      setIds: '1',
      name: uuid,
      isPublic: true,
      deletedAt: uuid === DELETED_BOARD_UUID ? new Date() : null,
    })),
  );
  await db.insert(dbSchema.gyms).values({ uuid: GYM_UUID, name: GYM_NAME, ownerId: GYM_OWNER });
  await db
    .insert(dbSchema.users)
    .values({ id: SYSTEM_OWNER, email: 'system@boardsesh.com', name: 'Boardsesh' })
    .onConflictDoNothing();
  await db.insert(dbSchema.gyms).values({ uuid: UNCLAIMED_GYM_UUID, name: 'Unclaimed wall', ownerId: SYSTEM_OWNER });
  await db.insert(dbSchema.userBoards).values([
    {
      uuid: SYSTEM_BOARD_UUID,
      slug: SYSTEM_BOARD_UUID,
      ownerId: SYSTEM_OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 30,
      setIds: '1',
      name: SYSTEM_BOARD_UUID,
      isPublic: true,
    },
    {
      uuid: SPRAY_BOARD_UUID,
      slug: SPRAY_BOARD_UUID,
      ownerId: BOARD_OWNER,
      boardType: 'spray',
      layoutId: 990_385,
      sizeId: 990_385,
      setIds: '1',
      name: SPRAY_BOARD_UUID,
      isPublic: true,
    },
  ]);
});

beforeEach(async () => {
  await db.delete(dbSchema.notifications);
});

const ownedItems: Array<{ label: string; item: Commentable; owner: string; type: string }> = [
  { label: 'session', item: { entityType: 'session', entityId: SESSION_ID }, owner: HOST, type: 'comment_on_session' },
  { label: 'climb', item: { entityType: 'climb', entityId: CLIMB_UUID }, owner: SETTER, type: 'comment_on_climb' },
  {
    label: 'playlist thread',
    item: { entityType: 'playlist_climb', entityId: `${PLAYLIST_UUID}:_all` },
    owner: PLAYLIST_OWNER,
    type: 'comment_on_playlist',
  },
  {
    label: 'climb inside a playlist',
    item: { entityType: 'playlist_climb', entityId: `${PLAYLIST_UUID}:${CLIMB_UUID}` },
    owner: PLAYLIST_OWNER,
    type: 'comment_on_playlist',
  },
  { label: 'board', item: { entityType: 'board', entityId: BOARD_UUID }, owner: BOARD_OWNER, type: 'comment_on_board' },
  { label: 'gym', item: { entityType: 'gym', entityId: GYM_UUID }, owner: GYM_OWNER, type: 'comment_on_gym' },
];

describe('the owner of a commented item', () => {
  it.each(ownedItems)('hears about a comment on their $label, once, naming a private commenter', async (owned) => {
    await seedSession();
    await commentThroughWorker(owned.item, PRIVATE_COMMENTER);

    const rows = await notificationsAbout(owned.item.entityId);
    expect(rows).toEqual([
      { recipientId: owned.owner, actorId: PRIVATE_COMMENTER, type: owned.type, commentId: expect.any(Number) },
    ]);

    // The owner's inbox names the private commenter and opens the thread.
    const inbox = await socialNotificationQueries.notifications(null, {}, viewer(owned.owner));
    expect(inbox.notifications.map((row) => [row.type, row.actorId, row.entityId])).toEqual([
      [owned.type, PRIVATE_COMMENTER, owned.item.entityId],
    ]);
    const { groups } = await socialNotificationQueries.groupedNotifications(null, {}, viewer(owned.owner));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      type: owned.type,
      actors: [expect.objectContaining({ id: PRIVATE_COMMENTER })],
      threadEntityType: owned.item.entityType,
      threadEntityId: owned.item.entityId,
      commentBody: `Comment by ${PRIVATE_COMMENTER}`,
    });
  });

  it.each(ownedItems)('is never told about their own comment on their $label', async (owned) => {
    await seedSession();
    await commentThroughWorker(owned.item, owned.owner);
    expect(await notificationsAbout(owned.item.entityId)).toEqual([]);
  });

  it('names the climb and the gym on their rows, so the copy can say which one', async () => {
    await commentThroughWorker({ entityType: 'climb', entityId: CLIMB_UUID }, PUBLIC_COMMENTER);
    await commentThroughWorker({ entityType: 'gym', entityId: GYM_UUID }, PUBLIC_COMMENTER);

    const [climbGroup] = (await socialNotificationQueries.groupedNotifications(null, {}, viewer(SETTER))).groups;
    expect(climbGroup).toMatchObject({
      type: 'comment_on_climb',
      climbUuid: CLIMB_UUID,
      climbName: CLIMB_NAME,
      boardType: 'kilter',
      climbLayoutId: 1,
    });
    const [gymGroup] = (await socialNotificationQueries.groupedNotifications(null, {}, viewer(GYM_OWNER))).groups;
    expect(gymGroup).toMatchObject({ type: 'comment_on_gym', gymName: GYM_NAME });
  });

  it('gets one notification when someone replies to their own comment on their item', async () => {
    await seedSession();
    const session: Commentable = { entityType: 'session', entityId: SESSION_ID };
    const hostRoot = await commentThroughWorker(session, HOST);
    await commentThroughWorker(session, PRIVATE_COMMENTER, hostRoot);

    // The reply is the one row: the host is the parent's author AND the session's host.
    expect(await notificationsAbout(SESSION_ID)).toEqual([
      { recipientId: HOST, actorId: PRIVATE_COMMENTER, type: 'comment_reply', commentId: expect.any(Number) },
    ]);
  });

  it('tells the host about a reply between two other climbers, and keeps a private reply from the parent', async () => {
    await seedSession();
    const session: Commentable = { entityType: 'session', entityId: SESSION_ID };
    const strangerRoot = await commentThroughWorker(session, STRANGER);
    await db.delete(dbSchema.notifications);
    await commentThroughWorker(session, PRIVATE_COMMENTER, strangerRoot);

    // The host reads every comment on their session; the stranger may not read a
    // private climber's reply, so the stranger hears nothing (the #6356 reply rule).
    expect(await notificationsAbout(SESSION_ID)).toEqual([
      { recipientId: HOST, actorId: PRIVATE_COMMENTER, type: 'comment_on_session', commentId: expect.any(Number) },
    ]);
  });

  it('does not tell a setter known only by an Aurora setter_id', async () => {
    await commentThroughWorker({ entityType: 'climb', entityId: AURORA_CLIMB_UUID }, PUBLIC_COMMENTER);
    expect(await notificationsAbout(AURORA_CLIMB_UUID)).toEqual([]);
  });

  it('does not write into the system account for an unclaimed gym or a system-owned board', async () => {
    // It owns them for reads, but nobody reads its inbox.
    await commentThroughWorker({ entityType: 'gym', entityId: UNCLAIMED_GYM_UUID }, PRIVATE_COMMENTER);
    await commentThroughWorker({ entityType: 'board', entityId: SYSTEM_BOARD_UUID }, PRIVATE_COMMENTER);
    const gymComment = await insertComment({ entityType: 'gym', entityId: UNCLAIMED_GYM_UUID }, PUBLIC_COMMENTER);
    await publishSocialEvent(
      commentEvent({ entityType: 'gym', entityId: UNCLAIMED_GYM_UUID }, PUBLIC_COMMENTER, gymComment),
    );

    expect(await notificationsAbout(UNCLAIMED_GYM_UUID)).toEqual([]);
    expect(await notificationsAbout(SYSTEM_BOARD_UUID)).toEqual([]);
  });

  it('marks a comment on a Spraywall so the copy never calls it a bare board', async () => {
    await commentThroughWorker({ entityType: 'board', entityId: SPRAY_BOARD_UUID }, PUBLIC_COMMENTER);
    await commentThroughWorker({ entityType: 'board', entityId: BOARD_UUID }, PUBLIC_COMMENTER);

    const { groups } = await socialNotificationQueries.groupedNotifications(null, {}, viewer(BOARD_OWNER));
    expect(
      groups
        .map((group) => [group.type, group.entityId, group.boardType])
        .sort(([, first], [, second]) => String(first).localeCompare(String(second))),
    ).toEqual(
      [
        ['comment_on_board', BOARD_UUID, 'kilter'],
        ['comment_on_board', SPRAY_BOARD_UUID, 'spray'],
      ].sort(([, first], [, second]) => String(first).localeCompare(String(second))),
    );
  });

  it('does not write into the recommendations account for a generated playlist', async () => {
    const thread = `${RECOMMENDED_PLAYLIST_UUID}:_all`;
    await commentThroughWorker({ entityType: 'playlist_climb', entityId: thread }, PRIVATE_COMMENTER);
    expect(await notificationsAbout(thread)).toEqual([]);
  });

  it('writes one row when the broker delivers the same comment twice', async () => {
    // The broker acknowledges only after the whole handler, feed fan-out
    // included, and reclaims what it never acknowledged.
    await seedSession();
    const session: Commentable = { entityType: 'session', entityId: SESSION_ID };
    const strangerRoot = await insertComment(session, STRANGER);
    const replyUuid = await insertComment(session, PUBLIC_COMMENTER, strangerRoot);
    const redelivered = commentEvent(session, PUBLIC_COMMENTER, replyUuid, strangerRoot);
    const handleEvent = captureWorkerHandler();
    await handleEvent(redelivered);
    await handleEvent(redelivered);

    // One row each for the host (owner) and the stranger (reply), not two.
    expect(
      (await notificationsAbout(SESSION_ID))
        .map(({ recipientId, type }) => `${type}:${recipientId}`)
        .sort((first, second) => first.localeCompare(second)),
    ).toEqual([`comment_on_session:${HOST}`, `comment_reply:${STRANGER}`]);

    // A second comment from the same person is still its own notification.
    await commentThroughWorker(session, PUBLIC_COMMENTER);
    expect(
      (await notificationsAbout(SESSION_ID)).filter(
        (row) => row.recipientId === HOST && row.type === 'comment_on_session',
      ),
    ).toHaveLength(2);
  });

  it('gives a deleted board no owner to tell', async () => {
    await commentThroughWorker({ entityType: 'board', entityId: DELETED_BOARD_UUID }, PUBLIC_COMMENTER);
    expect(await notificationsAbout(DELETED_BOARD_UUID)).toEqual([]);
  });
});

describe('a draft or unlisted climb', () => {
  it('takes a comment from its owner only, and the owner is not told about their own', async () => {
    for (const climbUuid of [DRAFT_CLIMB_UUID, UNLISTED_CLIMB_UUID]) {
      await expect(
        socialCommentMutations.addComment(
          null,
          { input: { entityType: 'climb', entityId: climbUuid, body: 'Can I try?' } },
          viewer(STRANGER),
        ),
      ).rejects.toThrow();
      await commentThroughWorker({ entityType: 'climb', entityId: climbUuid }, SETTER);
      expect(await notificationsAbout(climbUuid)).toEqual([]);
    }
  });

  it('tells only its owner about a comment written before it was unlisted', async () => {
    const climb: Commentable = { entityType: 'climb', entityId: UNLISTED_CLIMB_UUID };
    // Comments a stranger could write while it was still listed.
    const strangerRoot = await insertComment(climb, STRANGER);
    await commentThroughWorker(climb, PUBLIC_COMMENTER, strangerRoot);

    // The stranger it answers is not told: an inbox is a list, and nothing about
    // an unlisted climb reaches anyone but its owner.
    expect(await notificationsAbout(UNLISTED_CLIMB_UUID)).toEqual([
      { recipientId: SETTER, actorId: PUBLIC_COMMENTER, type: 'comment_on_climb', commentId: expect.any(Number) },
    ]);
  });
});

describe('local-only mode (no Redis)', () => {
  it('writes every comment with its comment id, as the worker does', async () => {
    await seedSession();
    const session: Commentable = { entityType: 'session', entityId: SESSION_ID };
    for (let count = 0; count < 2; count++) {
      const commentUuid = await insertComment(session, PUBLIC_COMMENTER);
      await publishSocialEvent(commentEvent(session, PUBLIC_COMMENTER, commentUuid));
    }

    // Two comments inside the hour are two notifications, each carrying its comment.
    const rows = await notificationsAbout(SESSION_ID);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.type === 'comment_on_session' && row.commentId !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.commentId)).size).toBe(2);
  });

  it('tells the same owner, naming a private commenter', async () => {
    await seedSession();
    const session: Commentable = { entityType: 'session', entityId: SESSION_ID };
    const commentUuid = await insertComment(session, PRIVATE_COMMENTER);
    // No broker in tests, so this takes the inline path.
    await publishSocialEvent(commentEvent(session, PRIVATE_COMMENTER, commentUuid));

    expect(
      (await notificationsAbout(SESSION_ID)).map(({ recipientId, actorId, type }) => [recipientId, actorId, type]),
    ).toEqual([[HOST, PRIVATE_COMMENTER, 'comment_on_session']]);
  });

  it('keeps a private reply from the stranger it answers', async () => {
    const climb: Commentable = { entityType: 'climb', entityId: CLIMB_UUID };
    const strangerRoot = await insertComment(climb, STRANGER);
    const replyUuid = await insertComment(climb, PRIVATE_COMMENTER, strangerRoot);
    await publishSocialEvent(commentEvent(climb, PRIVATE_COMMENTER, replyUuid, strangerRoot));

    expect(
      (await notificationsAbout(CLIMB_UUID)).map(({ recipientId, actorId, type }) => [recipientId, actorId, type]),
    ).toEqual([[SETTER, PRIVATE_COMMENTER, 'comment_on_climb']]);
  });
});

describe('one owner definition', () => {
  it('names as recipients exactly the users entityOwnerCondition treats as owners', async () => {
    await seedSession();
    const strangerComment = await insertComment({ entityType: 'climb', entityId: CLIMB_UUID }, STRANGER);
    const cases: Array<[entityType: string, entityId: string]> = [
      ['session', SESSION_ID],
      ['climb', CLIMB_UUID],
      ['climb', AURORA_CLIMB_UUID],
      ['playlist_climb', `${PLAYLIST_UUID}:_all`],
      ['playlist_climb', `${PLAYLIST_UUID}:${CLIMB_UUID}`],
      ['playlist_climb', PLAYLIST_UUID],
      ['board', BOARD_UUID],
      ['board', DELETED_BOARD_UUID],
      ['gym', GYM_UUID],
      // The system account still owns an unclaimed gym here, for reads; only
      // the recipient resolver drops it.
      ['gym', UNCLAIMED_GYM_UUID],
      ['comment', strangerComment],
    ];
    for (const [entityType, entityId] of cases) {
      const ownerQuery = entityOwnerIdsQuery(entityType, entityId);
      if (!ownerQuery) throw new Error(`${entityType} should have an owner query`);
      const recipients = (await executeRows<{ owner_id: string }>(db, ownerQuery)).map((row) => row.owner_id);
      const owners: string[] = [];
      for (const userId of [...ALL_USERS, SYSTEM_OWNER]) {
        const [probe] = await db
          .select({ owned: entityOwnerCondition(entityType, sql`${entityId}::text`, userId) })
          .from(sql`(SELECT 1) owner_probe`);
        if (probe.owned) owners.push(userId);
      }
      expect({ entityType, entityId, recipients: recipients.sort() }).toEqual({
        entityType,
        entityId,
        recipients: owners.sort(),
      });
    }
    // A proposal has no owner, and neither does a type the table does not know.
    expect(entityOwnerIdsQuery('proposal', randomUUID())).toBeNull();
    expect(entityOwnerIdsQuery('not-a-type', SESSION_ID)).toBeNull();
    expect(entityOwnerIdsQuery('constructor', SESSION_ID)).toBeNull();
  });
});

describe('a report on your climb', () => {
  const PRIVATE_REPORTER = `${PREFIX}-private-reporter`;
  const PUBLIC_REPORTER = `${PREFIX}-public-reporter`;

  beforeAll(async () => {
    await db
      .insert(dbSchema.users)
      .values([PRIVATE_REPORTER, PUBLIC_REPORTER].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db.insert(dbSchema.userProfiles).values({ userId: PRIVATE_REPORTER, isPrivate: true, privacyRevision: 1 });
  });

  async function report(reporterId: string): Promise<{ proposalUuid: string; event: SocialEvent }> {
    const proposalUuid = randomUUID();
    await db.insert(dbSchema.climbProposals).values({
      uuid: proposalUuid,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      proposerId: reporterId,
      type: 'hide',
      proposedValue: 'true',
      currentValue: 'false',
    });
    return {
      proposalUuid,
      event: {
        type: 'proposal.created',
        actorId: reporterId,
        entityType: 'proposal',
        entityId: proposalUuid,
        timestamp: Date.now(),
        metadata: { climbUuid: CLIMB_UUID, boardType: 'kilter', proposalType: 'hide' },
      },
    };
  }

  it('reaches the setter without naming a private reporter', async () => {
    const { proposalUuid, event } = await report(PRIVATE_REPORTER);
    await captureWorkerHandler()(event);

    expect(await notificationsAbout(proposalUuid)).toEqual([
      { recipientId: SETTER, actorId: null, type: 'proposal_on_your_climb', commentId: null },
    ]);

    const inbox = await socialNotificationQueries.notifications(null, {}, viewer(SETTER));
    expect(inbox.notifications.map((row) => [row.type, row.actorId, row.actorDisplayName])).toEqual([
      ['proposal_on_your_climb', null, undefined],
    ]);
    // No actor on the group, so the app reads it as "Someone reported your climb".
    const [group] = (await socialNotificationQueries.groupedNotifications(null, {}, viewer(SETTER))).groups;
    expect(group).toMatchObject({
      type: 'proposal_on_your_climb',
      actorCount: 0,
      actors: [],
      proposalType: 'hide',
      climbName: CLIMB_NAME,
    });
  });

  it('still names a public reporter', async () => {
    const { proposalUuid, event } = await report(PUBLIC_REPORTER);
    await captureWorkerHandler()(event);

    expect(await notificationsAbout(proposalUuid)).toEqual([
      { recipientId: SETTER, actorId: PUBLIC_REPORTER, type: 'proposal_on_your_climb', commentId: null },
    ]);
  });

  it('writes one unnamed row when the same report is delivered twice', async () => {
    const { proposalUuid, event } = await report(PRIVATE_REPORTER);
    const handleEvent = captureWorkerHandler();
    await handleEvent(event);
    await handleEvent(event);

    expect(await notificationsAbout(proposalUuid)).toEqual([
      { recipientId: SETTER, actorId: null, type: 'proposal_on_your_climb', commentId: null },
    ]);
  });

  it('still dedups a named report delivered twice', async () => {
    const { proposalUuid, event } = await report(PUBLIC_REPORTER);
    const handleEvent = captureWorkerHandler();
    await handleEvent(event);
    await handleEvent(event);

    expect(await notificationsAbout(proposalUuid)).toHaveLength(1);
  });

  it('lets a like from someone new through after a deleted account left an unnamed like', async () => {
    // A NULL actor on a like is a deleted account, not a hidden one, so it must
    // not swallow the next person's like on the same tick.
    const tickUuid = `${PREFIX}-tick`;
    await db.insert(dbSchema.boardseshTicks).values({
      uuid: tickUuid,
      userId: HOST,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      angle: 40,
      status: 'send',
      climbedAt: '2026-10-01T10:00:00Z',
    });
    await db.insert(dbSchema.notifications).values({
      uuid: randomUUID(),
      recipientId: HOST,
      actorId: null,
      type: 'vote_on_tick',
      entityType: 'tick',
      entityId: tickUuid,
    });
    await captureWorkerHandler()({
      type: 'vote.cast',
      actorId: PUBLIC_COMMENTER,
      entityType: 'tick',
      entityId: tickUuid,
      timestamp: Date.now(),
      metadata: {},
    });

    const likes = await db
      .select({ actorId: dbSchema.notifications.actorId })
      .from(dbSchema.notifications)
      .where(and(eq(dbSchema.notifications.entityId, tickUuid), eq(dbSchema.notifications.type, 'vote_on_tick')));
    const likers = likes.map((like) => like.actorId);
    expect(likers).toHaveLength(2);
    expect(likers).toEqual(expect.arrayContaining([PUBLIC_COMMENTER, null]));
  });
});
