import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import { socialVoteQueries } from '../graphql/resolvers/social/votes';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';

const owner = 'social-enum-owner';
const publicOwner = 'social-enum-public-owner';
const approved = 'social-enum-approved';
const stranger = 'social-enum-stranger';
/** A private account that did not set any of the climbs. */
const otherPrivate = 'social-enum-other-private';
const publicClimb = 'social-enum-public-climb';
const privateClimb = 'social-enum-private-climb';
const draftClimb = 'social-enum-draft-climb';
const publicSession = 'social-enum-public-session';
const privateSession = 'social-enum-private-session';
const recipients = [owner, approved, stranger];
const climbs = [
  { uuid: publicClimb, userId: publicOwner },
  { uuid: privateClimb, userId: owner },
  { uuid: draftClimb, userId: owner },
];

function context(userId: string | null): ConnectionContext {
  return { userId, isAuthenticated: userId !== null, connectionId: 'social-enum-test' } as ConnectionContext;
}

beforeAll(async () => {
  await db
    .insert(schema.users)
    .values(
      [owner, publicOwner, approved, stranger, otherPrivate].map((id) => ({ id, email: `${id}@test.com`, name: id })),
    );
  await db.insert(schema.userProfiles).values([
    { userId: owner, isPrivate: true },
    { userId: otherPrivate, isPrivate: true },
  ]);
  await db.insert(schema.userFollows).values({ followerId: approved, followingId: owner });
  await db.insert(schema.userFollowRequests).values({ requesterId: stranger, recipientId: owner });
  await db.insert(schema.boardClimbs).values(
    climbs.map((climb) => ({
      ...climb,
      boardType: 'kilter',
      layoutId: 1,
      name: climb.uuid,
      // A published climb is public whoever set it; the draft is its owner's alone.
      isListed: climb.uuid !== draftClimb,
      isDraft: climb.uuid === draftClimb,
      frames: 'p1r1',
    })),
  );
  await db.insert(schema.notifications).values(
    recipients.flatMap((recipientId) => [
      ...climbs.map((climb) => ({
        uuid: `${recipientId}-${climb.uuid}`,
        recipientId,
        actorId: climb.userId,
        type: 'new_climb' as const,
        entityType: 'climb' as const,
        entityId: climb.uuid,
      })),
      {
        uuid: `${recipientId}-already-read`,
        recipientId,
        actorId: publicOwner,
        type: 'new_climb' as const,
        entityType: 'climb' as const,
        entityId: publicClimb,
        readAt: new Date(),
      },
    ]),
  );
  // Only a climb's own author is public with it. A row about the private
  // account's published climb that names a different private account is that
  // account's activity, so the stranger never sees it.
  await db.insert(schema.notifications).values({
    uuid: `${stranger}-other-private-actor`,
    recipientId: stranger,
    actorId: otherPrivate,
    type: 'new_climb',
    entityType: 'climb',
    entityId: privateClimb,
  });
  await db.insert(schema.feedItems).values({
    recipientId: stranger,
    actorId: otherPrivate,
    type: 'new_climb',
    entityType: 'climb',
    entityId: privateClimb,
  });
  await db.insert(schema.feedItems).values(
    recipients.flatMap((recipientId) =>
      climbs.map((climb) => ({
        recipientId,
        actorId: climb.userId,
        type: 'new_climb' as const,
        entityType: 'climb' as const,
        entityId: climb.uuid,
      })),
    ),
  );
  await db.insert(schema.resourcePrivacy).values({
    kind: 'session',
    resourceId: privateSession,
    ownerId: owner,
    audience: 'invite_only',
  });
  await db.insert(schema.resourceGrants).values({
    kind: 'session',
    resourceId: privateSession,
    userId: approved,
    status: 'approved',
  });
  await db.insert(schema.voteCounts).values(
    [publicSession, privateSession].map((entityId) => ({
      entityType: 'session' as const,
      entityId,
      upvotes: 3,
      downvotes: 1,
      score: 2,
      createdAt: new Date(),
    })),
  );
  // Stale votes must remain hidden after access to their session is lost.
  await db.insert(schema.votes).values(
    [approved, stranger].flatMap((userId) =>
      [publicSession, privateSession].map((entityId) => ({
        userId,
        entityType: 'session' as const,
        entityId,
        value: 1,
      })),
    ),
  );
});

beforeEach(async () => {
  // The shared harness clears live sessions before each test.
  await db.insert(schema.boardSessions).values([
    { id: publicSession, boardPath: 'kilter/1/1/1/40', createdByUserId: publicOwner, isPublic: true },
    { id: privateSession, boardPath: 'kilter/1/1/1/40', createdByUserId: owner, isPublic: true },
  ]);
});

describe('social privacy queries with production PostgreSQL enum types', () => {
  it('uses the production entity enum in every social table', async () => {
    const columns = await db.execute(sql`
      SELECT table_name, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'entity_type'
        AND table_name IN ('comments', 'votes', 'vote_counts', 'notifications', 'feed_items')
      ORDER BY table_name
    `);
    expect([...columns]).toEqual(
      ['comments', 'feed_items', 'notifications', 'vote_counts', 'votes'].map((tableName) => ({
        table_name: tableName,
        udt_name: 'social_entity_type',
      })),
    );
  });

  it.each([
    { viewer: owner, visible: [publicClimb, privateClimb, draftClimb] },
    { viewer: approved, visible: [publicClimb, privateClimb] },
    // Who set a published, listed climb is public with it (#6418), so a
    // stranger (whose follow request is pending) gets the private account's
    // new-climb row, naming it. The row naming another private account on the
    // same climb stays hidden, and the draft stays with its owner.
    { viewer: stranger, visible: [publicClimb, privateClimb] },
  ])('counts unread notifications within $viewer privacy access', async ({ viewer, visible }) => {
    expect(await socialNotificationQueries.unreadNotificationCount(null, {}, context(viewer))).toBe(visible.length);
  });

  it.each([
    { viewer: owner, visible: [publicClimb, privateClimb, draftClimb] },
    { viewer: approved, visible: [publicClimb, privateClimb] },
    { viewer: stranger, visible: [publicClimb, privateClimb] },
  ])('filters materialized feed rows within $viewer privacy access', async ({ viewer, visible }) => {
    const feed = await activityFeedQueries.activityFeed(null, {}, context(viewer));
    expect(feed.items.map((item) => item.entityId).sort()).toEqual([...visible].sort());
    // Every row names the climb's own author, never the other private account.
    expect(feed.items.map((item) => item.actorId)).not.toContain(otherPrivate);
    expect(feed.hasMore).toBe(false);
  });

  it.each([
    { viewer: owner, privateAllowed: true, hasVoted: false },
    { viewer: approved, privateAllowed: true, hasVoted: true },
    { viewer: stranger, privateAllowed: false, hasVoted: true },
    { viewer: null, privateAllowed: false, hasVoted: false },
  ])('returns session vote summaries within $viewer privacy access', async ({ viewer, privateAllowed, hasVoted }) => {
    const summaries = await socialVoteQueries.bulkVoteSummaries(
      null,
      {
        input: { entityType: 'session', entityIds: [publicSession, privateSession] },
      },
      context(viewer),
    );
    expect(summaries).toEqual([
      {
        entityType: 'session',
        entityId: publicSession,
        upvotes: 3,
        downvotes: 1,
        voteScore: 2,
        userVote: hasVoted ? 1 : 0,
      },
      {
        entityType: 'session',
        entityId: privateSession,
        upvotes: privateAllowed ? 3 : 0,
        downvotes: privateAllowed ? 1 : 0,
        voteScore: privateAllowed ? 2 : 0,
        userVote: privateAllowed && hasVoted ? 1 : 0,
      },
    ]);
  });
});
