/**
 * Real-DB coverage for unlisted home boards on discovery surfaces. A board's
 * UUID is its link: anyone holding it opens the board's comment thread, but a
 * comment on the board carries that UUID, so it never reaches the global comment
 * feed or the activity feed of someone who does not already hold the board (its
 * owner, an approved grant, or follower inheritance).
 */
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';
import { canReadSocialEntity } from '../graphql/resolvers/shared/activity-privacy';

const BOARD_OWNER = 'unlisted-board-discovery-owner';
const GRANTEE = 'unlisted-board-discovery-grantee';
const COMMENTER = 'unlisted-board-discovery-commenter';
const FOLLOWER = 'unlisted-board-discovery-follower';
const STRANGER = 'unlisted-board-discovery-stranger';

// Legacy flags: `is_public = true, is_unlisted = true`.
const LEGACY_BOARD = 'unlisted-board-discovery-legacy';
// Legacy flags say listed; a modern `resource_privacy` policy says Unlisted.
const POLICY_BOARD = 'unlisted-board-discovery-policy';
const PUBLIC_BOARD = 'unlisted-board-discovery-public';

const LEGACY_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4001';
const POLICY_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4002';
const PUBLIC_COMMENT = '0b6c2d3e-5a41-4c8e-9f0d-7e1a2b3c4003';

const BOARD_COMMENTS: ReadonlyArray<[board: string, comment: string]> = [
  [LEGACY_BOARD, LEGACY_COMMENT],
  [POLICY_BOARD, POLICY_COMMENT],
  [PUBLIC_BOARD, PUBLIC_COMMENT],
];

const viewer = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `unlisted-board-discovery-${userId ?? 'anon'}`,
    isAuthenticated: !!userId,
    userId,
  }) as ConnectionContext;

async function globalFeedCommentIds(userId: string | null): Promise<string[]> {
  const feed = await socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, viewer(userId));
  return feed.comments.map((comment) => comment.uuid);
}

async function activityFeedCommentIds(userId: string): Promise<string[]> {
  const feed = await activityFeedQueries.activityFeed(null, { input: { limit: 50 } }, viewer(userId));
  return feed.items.filter((item) => item.entityType === 'comment').map((item) => item.entityId);
}

async function threadCommentIds(boardUuid: string, userId: string | null): Promise<string[]> {
  const thread = await socialCommentQueries.comments(
    null,
    { input: { entityType: 'board', entityId: boardUuid } },
    viewer(userId),
  );
  return thread.comments.map((comment) => comment.uuid);
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values(
      [BOARD_OWNER, GRANTEE, COMMENTER, FOLLOWER, STRANGER].map((id) => ({ id, email: `${id}@test.com`, name: id })),
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
  });
  await db.insert(dbSchema.resourceGrants).values(
    [LEGACY_BOARD, POLICY_BOARD].map((resourceId) => ({
      kind: 'board' as const,
      resourceId,
      userId: GRANTEE,
      status: 'approved' as const,
    })),
  );
  // The owner, the grant holder and a plain follower all follow the commenter,
  // so the comment fans out to each of them.
  await db
    .insert(dbSchema.userFollows)
    .values([BOARD_OWNER, GRANTEE, FOLLOWER].map((followerId) => ({ followerId, followingId: COMMENTER })));
  // The web board page posts with `entityType: 'board'` and the board's UUID.
  await db.insert(dbSchema.comments).values(
    BOARD_COMMENTS.map(([boardUuid, uuid]) => ({
      uuid,
      userId: COMMENTER,
      entityType: 'board' as const,
      entityId: boardUuid,
      body: `On ${boardUuid}`,
    })),
  );
  // The materialized feed points at the comment; the privacy chain walks up to its board.
  await db.insert(dbSchema.feedItems).values(
    [BOARD_OWNER, GRANTEE, FOLLOWER].flatMap((recipientId) =>
      BOARD_COMMENTS.map(([boardUuid, entityId]) => ({
        recipientId,
        actorId: COMMENTER,
        type: 'comment' as const,
        entityType: 'comment' as const,
        entityId,
        boardUuid,
        metadata: {},
      })),
    ),
  );
});

describe('unlisted boards on discovery surfaces', () => {
  it('keeps a public comment on an unlisted board off the global comment feed for outsiders', async () => {
    for (const outsider of [null, STRANGER, FOLLOWER]) {
      const ids = await globalFeedCommentIds(outsider);
      expect(ids).toContain(PUBLIC_COMMENT);
      expect(ids).not.toContain(LEGACY_COMMENT);
      expect(ids).not.toContain(POLICY_COMMENT);
    }
  });

  it('keeps it on the global comment feed for the board’s owner and an approved grant holder', async () => {
    for (const holder of [BOARD_OWNER, GRANTEE]) {
      expect(await globalFeedCommentIds(holder)).toEqual(
        expect.arrayContaining([LEGACY_COMMENT, POLICY_COMMENT, PUBLIC_COMMENT]),
      );
    }
  });

  it('keeps it out of a follower’s activity feed, and in the owner’s and grant holder’s', async () => {
    const followerIds = await activityFeedCommentIds(FOLLOWER);
    expect(followerIds).toContain(PUBLIC_COMMENT);
    expect(followerIds).not.toContain(LEGACY_COMMENT);
    expect(followerIds).not.toContain(POLICY_COMMENT);
    for (const holder of [BOARD_OWNER, GRANTEE]) {
      expect(await activityFeedCommentIds(holder)).toEqual(
        expect.arrayContaining([LEGACY_COMMENT, POLICY_COMMENT, PUBLIC_COMMENT]),
      );
    }
  });

  it('still opens the board’s own thread for anyone holding its link', async () => {
    for (const reader of [null, STRANGER, FOLLOWER, BOARD_OWNER, GRANTEE]) {
      expect(await threadCommentIds(LEGACY_BOARD, reader)).toEqual([LEGACY_COMMENT]);
      expect(await threadCommentIds(POLICY_BOARD, reader)).toEqual([POLICY_COMMENT]);
    }
    expect(await canReadSocialEntity('board', LEGACY_BOARD, null)).toBe(true);
    expect(await canReadSocialEntity('board', POLICY_BOARD, null)).toBe(true);
    expect(await canReadSocialEntity('comment', LEGACY_COMMENT, STRANGER)).toBe(true);
    expect(await canReadSocialEntity('comment', POLICY_COMMENT, STRANGER)).toBe(true);
  });
});
