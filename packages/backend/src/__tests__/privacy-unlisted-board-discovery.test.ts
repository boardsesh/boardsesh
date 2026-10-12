/**
 * Real-DB coverage for unlisted home boards on discovery surfaces. A board's
 * UUID is its link: anyone holding it opens the board's comment thread. A
 * comment on the board names that UUID as its `entityId`, so it reaches the
 * global comment feed or the activity feed only for people who already hold
 * the board (its owner, an approved grant, or follower inheritance), directly
 * or through a comment that references it.
 */
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';
import { canReadSocialEntity } from '../graphql/resolvers/shared/activity-privacy';

const BOARD_OWNER = 'unlisted-board-discovery-owner';
const GRANTEE = 'unlisted-board-discovery-grantee';
const COMMENTER = 'unlisted-board-discovery-commenter';
// Follows the commenter only.
const FOLLOWER = 'unlisted-board-discovery-follower';
// Follows the board owner (and the commenter, so the comments fan out to them).
const OWNER_FOLLOWER = 'unlisted-board-discovery-owner-follower';
const STRANGER = 'unlisted-board-discovery-stranger';

// Legacy flags: `is_public = true, is_unlisted = true`, no policy row, so no follower inheritance.
const LEGACY_BOARD = 'unlisted-board-discovery-legacy';
// Legacy flags say listed; a modern `resource_privacy` row says Unlisted and lets the owner's followers in.
const POLICY_BOARD = 'unlisted-board-discovery-policy';
const PUBLIC_BOARD = 'unlisted-board-discovery-public';

const LEGACY_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4001';
const POLICY_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4002';
const PUBLIC_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4003';
// A comment whose entity is the policy board's comment: one reference above the board.
const REFERENCE_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4004';

const BOARD_COMMENTS: ReadonlyArray<[board: string, comment: string]> = [
  [LEGACY_BOARD, LEGACY_COMMENT],
  [POLICY_BOARD, POLICY_COMMENT],
  [PUBLIC_BOARD, PUBLIC_COMMENT],
];
const ALL_COMMENTS = [LEGACY_COMMENT, POLICY_COMMENT, PUBLIC_COMMENT, REFERENCE_COMMENT];

const viewer = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `unlisted-board-discovery-${userId ?? 'anon'}`,
    isAuthenticated: !!userId,
    userId,
  }) as ConnectionContext;

const globalFeed = (userId: string | null) =>
  socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, viewer(userId));

async function globalFeedCommentIds(userId: string | null): Promise<string[]> {
  return (await globalFeed(userId)).comments.map((comment) => comment.uuid);
}

const activityFeed = (userId: string) =>
  activityFeedQueries.activityFeed(null, { input: { limit: 50 } }, viewer(userId));

async function activityFeedCommentIds(userId: string): Promise<string[]> {
  return (await activityFeed(userId)).items
    .filter((item) => item.entityType === 'comment')
    .map((item) => item.entityId);
}

async function threadCommentIds(boardUuid: string, userId: string | null): Promise<string[]> {
  const thread = await socialCommentQueries.comments(
    null,
    { input: { entityType: 'board', entityId: boardUuid } },
    viewer(userId),
  );
  return thread.comments.map((comment) => comment.uuid);
}

function setGranteeStatus(boardUuid: string, status: 'approved' | 'revoked') {
  return db
    .update(dbSchema.resourceGrants)
    .set({ status })
    .where(
      and(
        eq(dbSchema.resourceGrants.kind, 'board'),
        eq(dbSchema.resourceGrants.resourceId, boardUuid),
        eq(dbSchema.resourceGrants.userId, GRANTEE),
      ),
    );
}

beforeAll(async () => {
  await db.insert(dbSchema.users).values(
    [BOARD_OWNER, GRANTEE, COMMENTER, FOLLOWER, OWNER_FOLLOWER, STRANGER].map((id) => ({
      id,
      email: `${id}@test.com`,
      name: id,
    })),
  );
  await db.insert(dbSchema.userBoards).values(
    [
      { uuid: LEGACY_BOARD, name: 'Link Only Garage', isUnlisted: true },
      { uuid: POLICY_BOARD, name: 'Policy Link Shed', isUnlisted: false },
      { uuid: PUBLIC_BOARD, name: 'Open Wall', isUnlisted: false },
    ].map((board) => ({
      ...board,
      slug: board.uuid,
      ownerId: BOARD_OWNER,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      isPublic: true,
    })),
  );
  await db.insert(dbSchema.resourcePrivacy).values({
    kind: 'board',
    resourceId: POLICY_BOARD,
    ownerId: BOARD_OWNER,
    audience: 'unlisted',
    inheritFollowers: true,
  });
  await db.insert(dbSchema.resourceGrants).values(
    [LEGACY_BOARD, POLICY_BOARD].map((resourceId) => ({
      kind: 'board' as const,
      resourceId,
      userId: GRANTEE,
      status: 'approved' as const,
    })),
  );
  await db
    .insert(dbSchema.userFollows)
    .values([
      ...[BOARD_OWNER, GRANTEE, FOLLOWER, OWNER_FOLLOWER].map((followerId) => ({ followerId, followingId: COMMENTER })),
      { followerId: OWNER_FOLLOWER, followingId: BOARD_OWNER },
    ]);
  // The web board page posts with `entityType: 'board'` and the board's UUID.
  await db.insert(dbSchema.comments).values([
    ...BOARD_COMMENTS.map(([boardUuid, uuid]) => ({
      uuid,
      userId: COMMENTER,
      entityType: 'board' as const,
      entityId: boardUuid,
      body: 'Board discussion',
    })),
    {
      uuid: REFERENCE_COMMENT,
      userId: COMMENTER,
      entityType: 'comment' as const,
      entityId: POLICY_COMMENT,
      body: 'A comment about that discussion',
    },
  ]);
  // The materialized feed points at the comment, and the privacy chain walks up
  // to its board. Comment fan-out writes no board UUID on the row.
  await db.insert(dbSchema.feedItems).values(
    [BOARD_OWNER, GRANTEE, FOLLOWER, OWNER_FOLLOWER].flatMap((recipientId) =>
      ALL_COMMENTS.map((entityId) => ({
        recipientId,
        actorId: COMMENTER,
        type: 'comment' as const,
        entityType: 'comment' as const,
        entityId,
        metadata: {},
      })),
    ),
  );
});

describe('unlisted boards on discovery surfaces', () => {
  it('keeps comments on an unlisted board, and comments about them, off the global feed for outsiders', async () => {
    for (const outsider of [null, STRANGER, FOLLOWER]) {
      const feed = await globalFeed(outsider);
      const ids = feed.comments.map((comment) => comment.uuid);
      expect(ids).toContain(PUBLIC_COMMENT);
      for (const hidden of [LEGACY_COMMENT, POLICY_COMMENT, REFERENCE_COMMENT]) expect(ids).not.toContain(hidden);
      const serialized = JSON.stringify(feed);
      expect(serialized).not.toContain(LEGACY_BOARD);
      expect(serialized).not.toContain(POLICY_BOARD);
    }
  });

  it('keeps them on the global feed for the board’s owner and an approved grant holder', async () => {
    for (const holder of [BOARD_OWNER, GRANTEE]) {
      expect(await globalFeedCommentIds(holder)).toEqual(expect.arrayContaining(ALL_COMMENTS));
    }
  });

  it('lets the owner’s followers in only where the board inherits followers', async () => {
    const ids = await globalFeedCommentIds(OWNER_FOLLOWER);
    expect(ids).toEqual(expect.arrayContaining([PUBLIC_COMMENT, POLICY_COMMENT, REFERENCE_COMMENT]));
    expect(ids).not.toContain(LEGACY_COMMENT);
    const activityIds = await activityFeedCommentIds(OWNER_FOLLOWER);
    expect(activityIds).toEqual(expect.arrayContaining([PUBLIC_COMMENT, POLICY_COMMENT, REFERENCE_COMMENT]));
    expect(activityIds).not.toContain(LEGACY_COMMENT);
  });

  it('keeps them out of a follower’s activity feed, and in the owner’s and grant holder’s', async () => {
    const followerFeed = await activityFeed(FOLLOWER);
    const followerIds = followerFeed.items.filter((item) => item.entityType === 'comment').map((item) => item.entityId);
    expect(followerIds).toContain(PUBLIC_COMMENT);
    for (const hidden of [LEGACY_COMMENT, POLICY_COMMENT, REFERENCE_COMMENT]) {
      expect(followerIds).not.toContain(hidden);
    }
    const serialized = JSON.stringify(followerFeed);
    expect(serialized).not.toContain(LEGACY_BOARD);
    expect(serialized).not.toContain(POLICY_BOARD);
    for (const holder of [BOARD_OWNER, GRANTEE]) {
      expect(await activityFeedCommentIds(holder)).toEqual(expect.arrayContaining(ALL_COMMENTS));
    }
  });

  it('withdraws a revoked grant holder’s discovery while the owner keeps it', async () => {
    await setGranteeStatus(POLICY_BOARD, 'revoked');
    try {
      const feed = await globalFeed(GRANTEE);
      const ids = feed.comments.map((comment) => comment.uuid);
      expect(ids).toContain(LEGACY_COMMENT);
      expect(ids).not.toContain(POLICY_COMMENT);
      expect(ids).not.toContain(REFERENCE_COMMENT);
      expect(JSON.stringify(feed)).not.toContain(POLICY_BOARD);
      expect(await activityFeedCommentIds(GRANTEE)).not.toContain(POLICY_COMMENT);
      expect(await globalFeedCommentIds(BOARD_OWNER)).toEqual(expect.arrayContaining(ALL_COMMENTS));
    } finally {
      await setGranteeStatus(POLICY_BOARD, 'approved');
    }
  });

  it('still opens the board’s own thread for anyone holding its link', async () => {
    for (const reader of [null, STRANGER, FOLLOWER, OWNER_FOLLOWER, BOARD_OWNER, GRANTEE]) {
      expect(await threadCommentIds(LEGACY_BOARD, reader)).toEqual([LEGACY_COMMENT]);
      expect(await threadCommentIds(POLICY_BOARD, reader)).toEqual([POLICY_COMMENT]);
    }
    expect(await canReadSocialEntity('board', LEGACY_BOARD, null)).toBe(true);
    expect(await canReadSocialEntity('board', POLICY_BOARD, null)).toBe(true);
    expect(await canReadSocialEntity('comment', LEGACY_COMMENT, STRANGER)).toBe(true);
    expect(await canReadSocialEntity('comment', REFERENCE_COMMENT, STRANGER)).toBe(true);
  });
});
