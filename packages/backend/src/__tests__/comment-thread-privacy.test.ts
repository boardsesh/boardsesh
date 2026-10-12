/**
 * Real-DB coverage for who reads a comment thread. A private climber's comment
 * is still their activity and stays hidden from strangers, with two readers who
 * are never strangers to it: the owner of the commented item, who sees every
 * comment and like on it (and hears about them where Boardsesh notifies), and
 * whoever replied in the thread, who reads every comment above their reply.
 *
 * A proposal has no owner: a proposer who does not follow a private moderator
 * or voter is never told their name, and nobody votes on a proposal whose climb
 * they cannot read.
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
import { socialProposalMutations } from '../graphql/resolvers/social/proposals/mutations';
import { canReadSocialEntity } from '../graphql/resolvers/shared/activity-privacy';

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
  entityType: 'tick' | 'climb' | 'proposal',
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

/** `entityOwnerCondition` on its own, outside any read path. */
async function ownsItem(entityType: string, entityId: string, viewerId: string): Promise<boolean> {
  const [row] = await db
    .select({ owned: entityOwnerCondition(entityType, sql`${entityId}::text`, viewerId) })
    .from(sql`(SELECT 1) owner_probe`);
  return row.owned;
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
    const owns = (entityId: string, viewerId: string) => ownsItem('playlist_climb', entityId, viewerId);
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

describe('the owner of each kind of item', () => {
  const SESSION_ID = 'thread-privacy-session';
  const SET_CLIMB_UUID = 'thread-privacy-set-climb';
  const BOARD_UUID = 'thread-privacy-board';
  const DELETED_BOARD_UUID = 'thread-privacy-deleted-board';
  const GYM_UUID = 'thread-privacy-gym';
  const DELETED_GYM_UUID = 'thread-privacy-deleted-gym';
  const PROPOSAL_UUID = 'thread-privacy-owner-proposal';

  it('is the host, setter, author or board and gym owner; a proposal or an unknown type has none', async () => {
    // The harness clears sessions before each case, so this one is seeded here.
    await db
      .insert(dbSchema.boardSessions)
      .values({ id: SESSION_ID, boardPath: 'kilter/1/1/1/40', createdByUserId: TICK_OWNER, isPublic: true });
    await db.insert(dbSchema.boardSessionParticipants).values({ sessionId: SESSION_ID, userId: REPLIER });
    await db.insert(dbSchema.boardClimbs).values({
      uuid: SET_CLIMB_UUID,
      boardType: 'kilter',
      layoutId: 1,
      userId: SIBLING,
      name: 'Thread privacy set climb',
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
    });
    await db.insert(dbSchema.userBoards).values(
      [BOARD_UUID, DELETED_BOARD_UUID].map((uuid, index) => ({
        uuid,
        slug: uuid,
        ownerId: TICK_OWNER,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10 + index,
        setIds: '1',
        name: uuid,
        deletedAt: uuid === DELETED_BOARD_UUID ? new Date() : null,
      })),
    );
    await db.insert(dbSchema.gyms).values(
      [GYM_UUID, DELETED_GYM_UUID].map((uuid) => ({
        uuid,
        name: uuid,
        ownerId: TICK_OWNER,
        deletedAt: uuid === DELETED_GYM_UUID ? new Date() : null,
      })),
    );
    await db.insert(dbSchema.climbProposals).values({
      uuid: PROPOSAL_UUID,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      angle: 40,
      proposerId: REPLIER,
      type: 'grade',
      proposedValue: '20',
      currentValue: '19',
    });

    const cases: Array<[entityType: string, entityId: string, viewerId: string, owned: boolean]> = [
      ['tick', TICK_UUID, TICK_OWNER, true],
      ['tick', TICK_UUID, STRANGER, false],
      // The host owns a session; a climber who joined it does not.
      ['session', SESSION_ID, TICK_OWNER, true],
      ['session', SESSION_ID, REPLIER, false],
      ['climb', SET_CLIMB_UUID, SIBLING, true],
      ['climb', SET_CLIMB_UUID, STRANGER, false],
      // A catalogue climb has no Boardsesh setter.
      ['climb', CLIMB_UUID, STRANGER, false],
      ['comment', privateTickComment, PRIVATE_CLIMBER, true],
      ['comment', privateTickComment, TICK_OWNER, false],
      ['board', BOARD_UUID, TICK_OWNER, true],
      ['board', DELETED_BOARD_UUID, TICK_OWNER, false],
      ['gym', GYM_UUID, TICK_OWNER, true],
      ['gym', DELETED_GYM_UUID, TICK_OWNER, false],
      // Moderation on someone else's climb: the proposer is not its owner.
      ['proposal', PROPOSAL_UUID, REPLIER, false],
      ['beta', TICK_UUID, TICK_OWNER, false],
      ['not-a-type', TICK_UUID, TICK_OWNER, false],
    ];
    const results = [];
    for (const [entityType, entityId, viewerId] of cases) {
      results.push(await ownsItem(entityType, entityId, viewerId));
    }
    expect(results).toEqual(cases.map(([, , , owned]) => owned));
  });

  it('still keeps a spray climb’s discussion from a setter who lost access to the wall', async () => {
    const wallOwner = 'thread-privacy-wall-owner';
    const sprayLayoutId = 990_601;
    const sprayClimbUuid = 'thread-privacy-spray-climb';
    await db.insert(dbSchema.users).values({ id: wallOwner, email: `${wallOwner}@test.com`, name: wallOwner });
    const wallBoardUuid = 'thread-privacy-spray-board';
    await db.insert(dbSchema.userBoards).values({
      uuid: wallBoardUuid,
      slug: wallBoardUuid,
      ownerId: wallOwner,
      boardType: 'spray',
      layoutId: sprayLayoutId,
      sizeId: sprayLayoutId,
      setIds: '1',
      name: 'Thread privacy home wall',
      isPublic: false,
    });
    await db.insert(dbSchema.sprayWalls).values({ boardUuid: wallBoardUuid, layoutId: sprayLayoutId });
    // SIBLING set it while the wall was shared with them; it is private now.
    await db.insert(dbSchema.boardClimbs).values({
      uuid: sprayClimbUuid,
      boardType: 'spray',
      layoutId: sprayLayoutId,
      userId: SIBLING,
      name: 'Thread privacy spray climb',
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
    });
    const wallComment = randomUUID();
    await db
      .insert(dbSchema.comments)
      .values({ uuid: wallComment, userId: wallOwner, entityType: 'climb', entityId: sprayClimbUuid, body: 'Mine' });

    expect(await ownsItem('climb', sprayClimbUuid, SIBLING)).toBe(true);
    expect(await readThread(SIBLING, 'climb', sprayClimbUuid)).toEqual([]);
    expect(await readThread(wallOwner, 'climb', sprayClimbUuid)).toEqual([wallComment]);
  });
});

describe('the author of a reply, beside a private subthread', () => {
  it('reads neither a private sibling reply nor the public replies under it', async () => {
    const privateSibling = 'thread-privacy-private-sibling';
    await db
      .insert(dbSchema.users)
      .values({ id: privateSibling, email: `${privateSibling}@test.com`, name: privateSibling });
    await db.insert(dbSchema.userProfiles).values({ userId: privateSibling, isPrivate: true, privacyRevision: 1 });
    const [root] = await db
      .select({ id: dbSchema.comments.id })
      .from(dbSchema.comments)
      .where(eq(dbSchema.comments.uuid, privateClimbRoot));
    const privateSiblingReply = randomUUID();
    const [siblingRow] = await db
      .insert(dbSchema.comments)
      .values({
        uuid: privateSiblingReply,
        userId: privateSibling,
        entityType: 'climb',
        entityId: CLIMB_UUID,
        parentCommentId: root.id,
        body: 'Drop knee instead',
      })
      .returning();
    const publicUnderPrivateSibling = randomUUID();
    await db.insert(dbSchema.comments).values({
      uuid: publicUnderPrivateSibling,
      userId: SIBLING,
      entityType: 'climb',
      entityId: CLIMB_UUID,
      parentCommentId: siblingRow.id,
      body: 'Tried it, no luck',
    });

    // Their own branch and the public sibling still read; the private branch does not.
    expect(await readThread(REPLIER, 'climb', CLIMB_UUID, privateClimbRoot)).toEqual(
      [replierAnswer, siblingAnswer].sort(),
    );
    expect(await readThread(REPLIER, 'climb', CLIMB_UUID, privateSiblingReply)).toEqual([]);
    expect(await canReadSocialEntity('comment', privateSiblingReply, REPLIER)).toBe(false);
    expect(await canReadSocialEntity('comment', publicUnderPrivateSibling, REPLIER)).toBe(false);
    // The public reply's own author replied under the private sibling, so they read it.
    expect(await readThread(SIBLING, 'climb', CLIMB_UUID, privateSiblingReply)).toEqual([publicUnderPrivateSibling]);
  });
});

describe('proposals', () => {
  const PROPOSER = 'thread-privacy-proposer';
  const MODERATOR = 'thread-privacy-moderator';
  // `voteOnProposal` validates its input as a UUID.
  const PROPOSAL_UUID = randomUUID();

  beforeAll(async () => {
    await db
      .insert(dbSchema.users)
      .values([PROPOSER, MODERATOR].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db.insert(dbSchema.userProfiles).values({ userId: MODERATOR, isPrivate: true, privacyRevision: 1 });
    await db.insert(dbSchema.climbProposals).values({
      uuid: PROPOSAL_UUID,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      angle: 40,
      proposerId: PROPOSER,
      type: 'grade',
      proposedValue: '20',
      currentValue: '19',
    });
  });

  it('never names a private moderator or voter to the proposer', async () => {
    const handleEvent = captureWorkerHandler();
    const proposalEvent = (type: 'proposal.voted' | 'proposal.approved' | 'proposal.rejected', actorId: string) =>
      handleEvent({
        type,
        actorId,
        entityType: 'proposal',
        entityId: PROPOSAL_UUID,
        timestamp: Date.now(),
        metadata: { climbUuid: CLIMB_UUID, boardType: 'kilter', value: '1' },
      });
    await proposalEvent('proposal.voted', PRIVATE_CLIMBER);
    await proposalEvent('proposal.approved', MODERATOR);
    await proposalEvent('proposal.rejected', MODERATOR);
    // A public voter is named, so the path itself delivers.
    await proposalEvent('proposal.voted', STRANGER);

    expect(await notificationTypes(PROPOSER, PRIVATE_CLIMBER)).toEqual([]);
    expect(await notificationTypes(PROPOSER, MODERATOR)).toEqual([]);
    expect(await notificationTypes(PROPOSER, STRANGER)).toEqual(['proposal_vote']);

    // Rows written before this rule (or by another path) stay out of the inbox too.
    await db.insert(dbSchema.notifications).values(
      (['proposal_approved', 'proposal_rejected'] as const).map((type) => ({
        uuid: randomUUID(),
        recipientId: PROPOSER,
        actorId: MODERATOR,
        type,
        entityType: 'proposal' as const,
        entityId: PROPOSAL_UUID,
      })),
    );
    await db.insert(dbSchema.notifications).values({
      uuid: randomUUID(),
      recipientId: PROPOSER,
      actorId: PRIVATE_CLIMBER,
      type: 'proposal_vote',
      entityType: 'proposal',
      entityId: PROPOSAL_UUID,
    });
    const inbox = await socialNotificationQueries.notifications(null, {}, viewer(PROPOSER));
    expect(inbox.notifications.map((notification) => [notification.type, notification.actorId])).toEqual([
      ['proposal_vote', STRANGER],
    ]);
  });

  it('keeps a later private reporter’s words from the first reporter', async () => {
    const firstReporter = 'thread-privacy-first-reporter';
    const laterReporter = 'thread-privacy-later-reporter';
    const reportUuid = 'thread-privacy-hide-report';
    await db
      .insert(dbSchema.users)
      .values([firstReporter, laterReporter].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db
      .insert(dbSchema.userProfiles)
      .values([firstReporter, laterReporter].map((userId) => ({ userId, isPrivate: true, privacyRevision: 1 })));
    await db.insert(dbSchema.climbProposals).values({
      uuid: reportUuid,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      proposerId: firstReporter,
      type: 'hide',
      proposedValue: 'true',
      currentValue: 'false',
      reason: 'First reporter’s reason, public on the proposal',
    });
    const firstWords = randomUUID();
    const laterWords = randomUUID();
    await db.insert(dbSchema.comments).values([
      { uuid: firstWords, userId: firstReporter, entityType: 'proposal', entityId: reportUuid, body: 'Dangerous hold' },
      { uuid: laterWords, userId: laterReporter, entityType: 'proposal', entityId: reportUuid, body: 'Same here' },
    ]);

    expect(await readThread(firstReporter, 'proposal', reportUuid)).toEqual([firstWords]);
    expect(await readThread(laterReporter, 'proposal', reportUuid)).toEqual([laterWords]);
    expect(await readThread(STRANGER, 'proposal', reportUuid)).toEqual([]);
  });

  it('turns away a vote on a proposal whose climb the voter cannot read', async () => {
    const setter = 'thread-privacy-private-setter';
    const wallOwner = 'thread-privacy-proposal-wall-owner';
    await db
      .insert(dbSchema.users)
      .values([setter, wallOwner].map((id) => ({ id, email: `${id}@test.com`, name: id })));
    await db.insert(dbSchema.userProfiles).values({ userId: setter, isPrivate: true, privacyRevision: 1 });
    const privateWallLayout = 990_611;
    const hiddenWallLayout = 990_612;
    await db.insert(dbSchema.userBoards).values(
      [
        { uuid: 'thread-privacy-private-wall', layoutId: privateWallLayout, isPublic: false },
        { uuid: 'thread-privacy-hidden-wall', layoutId: hiddenWallLayout, isPublic: true },
      ].map(({ uuid, layoutId, isPublic }) => ({
        uuid,
        slug: uuid,
        ownerId: wallOwner,
        boardType: 'spray',
        layoutId,
        sizeId: layoutId,
        setIds: '1',
        name: uuid,
        isPublic,
      })),
    );
    await db.insert(dbSchema.sprayWalls).values([
      { boardUuid: 'thread-privacy-private-wall', layoutId: privateWallLayout },
      // A public wall an admin hid after a report reads as private to everyone but its owner.
      { boardUuid: 'thread-privacy-hidden-wall', layoutId: hiddenWallLayout, hiddenAt: new Date() },
    ]);
    const climbs = [
      { uuid: 'thread-privacy-draft-climb', boardType: 'kilter', layoutId: 1, userId: SIBLING, isDraft: true },
      { uuid: 'thread-privacy-private-setter-climb', boardType: 'kilter', layoutId: 1, userId: setter, isDraft: false },
      {
        uuid: 'thread-privacy-private-wall-climb',
        boardType: 'spray',
        layoutId: privateWallLayout,
        userId: wallOwner,
        isDraft: false,
      },
      {
        uuid: 'thread-privacy-hidden-wall-climb',
        boardType: 'spray',
        layoutId: hiddenWallLayout,
        userId: wallOwner,
        isDraft: false,
      },
    ];
    await db
      .insert(dbSchema.boardClimbs)
      .values(climbs.map((climb) => ({ ...climb, name: climb.uuid, isListed: true, frames: 'p1r1' })));
    const proposalUuids = climbs.map(() => randomUUID());
    await db.insert(dbSchema.climbProposals).values(
      climbs.map((climb, index) => ({
        uuid: proposalUuids[index],
        climbUuid: climb.uuid,
        boardType: climb.boardType,
        angle: 40,
        proposerId: climb.userId,
        type: 'grade' as const,
        proposedValue: '20',
        currentValue: '19',
        reason: 'Only people who can read the climb read this',
      })),
    );

    const vote = (proposalUuid: string) =>
      socialProposalMutations.voteOnProposal(null, { input: { proposalUuid, value: 1 } }, viewer(STRANGER));
    for (const proposalUuid of proposalUuids) {
      await expect(vote(proposalUuid)).rejects.toThrow('Proposal not found');
    }
    const voteRows = await db
      .select({ id: dbSchema.proposalVotes.id })
      .from(dbSchema.proposalVotes)
      .where(eq(dbSchema.proposalVotes.userId, STRANGER));
    expect(voteRows).toEqual([]);

    // A climb the voter can read takes the vote and returns its reason.
    const readable = await vote(PROPOSAL_UUID);
    expect(readable).toMatchObject({ uuid: PROPOSAL_UUID, userVote: 1 });
  });
});
