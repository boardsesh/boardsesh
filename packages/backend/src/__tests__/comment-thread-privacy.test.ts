/**
 * Real-DB coverage for who reads a comment thread. A private climber's comment
 * is still their activity and stays hidden from strangers, with two readers who
 * are never strangers to it: the owner of the commented item, who sees every
 * comment and like on it (and hears about them), and whoever replied in the
 * thread, who reads every comment above their reply.
 */
import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { entityOwnerCondition } from '@boardsesh/db/queries';
import type { ConnectionContext, SocialEvent } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import type { EventBroker } from '../events/event-broker';
import { NotificationWorker } from '../events/notification-worker';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { socialVoteQueries } from '../graphql/resolvers/social/votes';

// Feed fan-out is not under test here; the notification rows are.
vi.mock('../events/feed-fanout', () => ({
  fanoutFeedItems: vi.fn(async () => {}),
  fanoutNewClimbFeedItems: vi.fn(async () => {}),
  fanoutCommentFeedItems: vi.fn(async () => {}),
  fanoutProposalApprovedFeedItems: vi.fn(async () => {}),
}));

const TICK_OWNER = 'thread-privacy-tick-owner';
const PRIVATE_CLIMBER = 'thread-privacy-private-climber';
const REPLIER = 'thread-privacy-replier';
const SIBLING = 'thread-privacy-sibling';
const STRANGER = 'thread-privacy-stranger';
const CLIMB_UUID = 'thread-privacy-catalog-climb';
const TICK_UUID = 'thread-privacy-tick';

const privateTickComment = randomUUID();
const strangerTickComment = randomUUID();
const privateReplyToStranger = randomUUID();
const privateClimbRoot = randomUUID();
const replierAnswer = randomUUID();
const siblingAnswer = randomUUID();

const viewer = (userId: string | null): ConnectionContext =>
  ({ connectionId: `thread-privacy-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

async function readThread(
  userId: string | null,
  entityType: 'tick' | 'climb',
  entityId: string,
  parentCommentUuid?: string,
): Promise<string[]> {
  const page = await socialCommentQueries.comments(
    null,
    { input: { entityType, entityId, ...(parentCommentUuid ? { parentCommentUuid } : {}) } },
    viewer(userId),
  );
  return page.comments.map((comment) => comment.uuid).sort();
}

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

async function notificationTypes(recipientId: string, actorId: string): Promise<string[]> {
  const rows = await db
    .select({ type: dbSchema.notifications.type })
    .from(dbSchema.notifications)
    .where(and(eq(dbSchema.notifications.recipientId, recipientId), eq(dbSchema.notifications.actorId, actorId)));
  return rows.map((row) => row.type).sort();
}

beforeAll(async () => {
  await db.insert(dbSchema.users).values(
    [TICK_OWNER, PRIVATE_CLIMBER, REPLIER, SIBLING, STRANGER].map((id) => ({
      id,
      email: `${id}@test.com`,
      name: id,
    })),
  );
  await db.insert(dbSchema.userProfiles).values({ userId: PRIVATE_CLIMBER, isPrivate: true, privacyRevision: 1 });
  await db.insert(dbSchema.boardClimbs).values({
    uuid: CLIMB_UUID,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Thread privacy catalogue climb',
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
  });
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: TICK_UUID,
    userId: TICK_OWNER,
    climbUuid: CLIMB_UUID,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    climbedAt: '2026-10-01T10:00:00Z',
  });
  const [strangerRoot] = await db
    .insert(dbSchema.comments)
    .values([
      { uuid: strangerTickComment, userId: STRANGER, entityType: 'tick', entityId: TICK_UUID, body: 'Nice one' },
      { uuid: privateTickComment, userId: PRIVATE_CLIMBER, entityType: 'tick', entityId: TICK_UUID, body: 'Psyched' },
    ])
    .returning();
  await db.insert(dbSchema.comments).values({
    uuid: privateReplyToStranger,
    userId: PRIVATE_CLIMBER,
    entityType: 'tick',
    entityId: TICK_UUID,
    parentCommentId: strangerRoot.id,
    body: 'Thanks',
  });
  const [climbRoot] = await db
    .insert(dbSchema.comments)
    .values({
      uuid: privateClimbRoot,
      userId: PRIVATE_CLIMBER,
      entityType: 'climb',
      entityId: CLIMB_UUID,
      body: 'Heel hook the start',
    })
    .returning();
  await db.insert(dbSchema.comments).values([
    {
      uuid: replierAnswer,
      userId: REPLIER,
      entityType: 'climb',
      entityId: CLIMB_UUID,
      parentCommentId: climbRoot.id,
      body: 'Worked for me',
    },
    {
      uuid: siblingAnswer,
      userId: SIBLING,
      entityType: 'climb',
      entityId: CLIMB_UUID,
      parentCommentId: climbRoot.id,
      body: 'Toe hook is easier',
    },
  ]);
  await db.insert(dbSchema.voteCounts).values({
    entityType: 'comment',
    entityId: privateTickComment,
    upvotes: 2,
    downvotes: 0,
    score: 2,
    createdAt: new Date(),
  });
});

describe('the owner of the commented item', () => {
  it('reads a private climber’s comment and reply on their tick; a stranger does not', async () => {
    expect(await readThread(TICK_OWNER, 'tick', TICK_UUID)).toEqual([privateTickComment, strangerTickComment].sort());
    expect(await readThread(TICK_OWNER, 'tick', TICK_UUID, strangerTickComment)).toEqual([privateReplyToStranger]);
    expect(await readThread(STRANGER, 'tick', TICK_UUID)).toEqual([strangerTickComment]);
    expect(await readThread(STRANGER, 'tick', TICK_UUID, strangerTickComment)).toEqual([]);
    expect(await readThread(null, 'tick', TICK_UUID)).toEqual([strangerTickComment]);
  });

  it('reads the likes on a private climber’s comment on their tick', async () => {
    const summary = (userId: string | null) =>
      socialVoteQueries.voteSummary(null, { entityType: 'comment', entityId: privateTickComment }, viewer(userId));
    expect(await summary(TICK_OWNER)).toMatchObject({ upvotes: 2, voteScore: 2 });
    expect(await summary(STRANGER)).toMatchObject({ upvotes: 0, voteScore: 0 });
  });

  it('hears about a private climber’s comment and like; the stranger they replied to does not', async () => {
    const handleEvent = captureWorkerHandler();
    await handleEvent({
      type: 'comment.created',
      actorId: PRIVATE_CLIMBER,
      entityType: 'tick',
      entityId: TICK_UUID,
      timestamp: Date.now(),
      metadata: { commentUuid: privateTickComment },
    });
    await handleEvent({
      type: 'comment.reply',
      actorId: PRIVATE_CLIMBER,
      entityType: 'tick',
      entityId: TICK_UUID,
      timestamp: Date.now(),
      metadata: { commentUuid: privateReplyToStranger, parentCommentId: strangerTickComment },
    });
    await handleEvent({
      type: 'vote.cast',
      actorId: PRIVATE_CLIMBER,
      entityType: 'tick',
      entityId: TICK_UUID,
      timestamp: Date.now(),
      metadata: {},
    });

    expect(await notificationTypes(TICK_OWNER, PRIVATE_CLIMBER)).toEqual([
      'comment_on_tick',
      'comment_on_tick',
      'vote_on_tick',
    ]);
    expect(await notificationTypes(STRANGER, PRIVATE_CLIMBER)).toEqual([]);

    const inbox = await socialNotificationQueries.notifications(null, {}, viewer(TICK_OWNER));
    expect(inbox.notifications.map((notification) => notification.type).sort()).toEqual([
      'comment_on_tick',
      'comment_on_tick',
      'vote_on_tick',
    ]);
  });

  it('lets a comment’s author read its likes and hear about a private climber’s like', async () => {
    expect(
      await socialVoteQueries.voteSummary(
        null,
        { entityType: 'comment', entityId: privateTickComment },
        viewer(PRIVATE_CLIMBER),
      ),
    ).toMatchObject({ upvotes: 2, voteScore: 2 });

    const handleEvent = captureWorkerHandler();
    await handleEvent({
      type: 'vote.cast',
      actorId: PRIVATE_CLIMBER,
      entityType: 'comment',
      entityId: replierAnswer,
      timestamp: Date.now(),
      metadata: {},
    });
    expect(await notificationTypes(REPLIER, PRIVATE_CLIMBER)).toEqual(['vote_on_comment']);
    const inbox = await socialNotificationQueries.notifications(null, {}, viewer(REPLIER));
    expect(inbox.notifications.map((notification) => notification.type)).toEqual(['vote_on_comment']);
  });

  it('names a playlist’s owner only from a well-formed playlist_climb id', async () => {
    const playlistUuid = randomUUID();
    const [playlist] = await db
      .insert(dbSchema.playlists)
      .values({ uuid: playlistUuid, boardType: 'kilter', name: 'Thread privacy', isPublic: true })
      .returning();
    await db.insert(dbSchema.playlistOwnership).values({ playlistId: playlist.id, userId: TICK_OWNER, role: 'owner' });
    const owns = async (entityId: string, viewerId: string) => {
      const [row] = await db
        .select({ owned: entityOwnerCondition('playlist_climb', sql`${entityId}::text`, viewerId) })
        .from(sql`(SELECT 1) owner_probe`);
      return row.owned;
    };
    expect(await owns(`${playlistUuid}:_all`, TICK_OWNER)).toBe(true);
    expect(await owns(`${playlistUuid}:${CLIMB_UUID}`, TICK_OWNER)).toBe(true);
    expect(await owns(`${playlistUuid}:_all`, STRANGER)).toBe(false);
    expect(await owns(playlistUuid, TICK_OWNER)).toBe(false);
    expect(await owns(`${playlistUuid}:a:b`, TICK_OWNER)).toBe(false);
  });
});

describe('the author of a reply', () => {
  it('reads every comment above their reply, and public replies beside it', async () => {
    expect(await readThread(REPLIER, 'climb', CLIMB_UUID)).toEqual([privateClimbRoot]);
    expect(await readThread(REPLIER, 'climb', CLIMB_UUID, privateClimbRoot)).toEqual(
      [replierAnswer, siblingAnswer].sort(),
    );
  });

  it('gives a reader who never replied nothing under a private root', async () => {
    expect(await readThread(STRANGER, 'climb', CLIMB_UUID)).toEqual([]);
    expect(await readThread(STRANGER, 'climb', CLIMB_UUID, privateClimbRoot)).toEqual([]);
    expect(await readThread(null, 'climb', CLIMB_UUID)).toEqual([]);
  });
});
