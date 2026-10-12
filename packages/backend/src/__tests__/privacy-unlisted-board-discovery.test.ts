/** Unlisted board UUIDs are capabilities; unsolicited comments cannot publish them. */
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';

const OWNER = 'board-discovery-owner';
const MEMBER = 'board-discovery-member';
const COMMENTER = 'board-discovery-commenter';
const STRANGER = 'board-discovery-stranger';
const PUBLIC_BOARD = 'board-discovery-public';
const LEGACY_BOARD = 'board-discovery-legacy';
const MODERN_BOARD = 'board-discovery-modern';
const BOARD_COMMENTS = [
  { uuid: 'board-discovery-public-comment', entityId: PUBLIC_BOARD },
  { uuid: 'board-discovery-legacy-comment', entityId: LEGACY_BOARD },
  { uuid: 'board-discovery-modern-comment', entityId: MODERN_BOARD },
];
const REFERENCE_COMMENT = 'board-discovery-referenced-comment';

const viewer = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `board-discovery-${userId ?? 'anonymous'}`,
    isAuthenticated: !!userId,
    userId,
  }) as ConnectionContext;

beforeAll(async () => {
  await db
    .insert(schema.users)
    .values([OWNER, MEMBER, COMMENTER, STRANGER].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  await db.insert(schema.userBoards).values(
    [PUBLIC_BOARD, LEGACY_BOARD, MODERN_BOARD].map((uuid) => ({
      uuid,
      slug: uuid,
      ownerId: OWNER,
      name: uuid,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      isPublic: true,
      isUnlisted: uuid === LEGACY_BOARD,
    })),
  );
  await db.insert(schema.resourcePrivacy).values({
    kind: 'board',
    resourceId: MODERN_BOARD,
    ownerId: OWNER,
    audience: 'unlisted',
  });
  await db.insert(schema.resourceGrants).values(
    [LEGACY_BOARD, MODERN_BOARD].map((resourceId) => ({
      kind: 'board' as const,
      resourceId,
      userId: MEMBER,
      status: 'approved' as const,
    })),
  );
  await db.insert(schema.comments).values([
    ...BOARD_COMMENTS.map((comment) => ({
      ...comment,
      userId: COMMENTER,
      entityType: 'board' as const,
      body: 'Board discussion',
    })),
    {
      uuid: REFERENCE_COMMENT,
      userId: COMMENTER,
      entityType: 'comment',
      entityId: BOARD_COMMENTS[2].uuid,
      body: 'A comment about that discussion',
    },
  ]);
  const commentIds = [...BOARD_COMMENTS.map((comment) => comment.uuid), REFERENCE_COMMENT];
  await db.insert(schema.feedItems).values(
    [OWNER, MEMBER, STRANGER].flatMap((recipientId) =>
      commentIds.map((entityId) => ({
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

const globalFeed = async (userId: string | null) =>
  socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, viewer(userId));

describe('Unlisted boards on discovery surfaces', () => {
  it.each([null, STRANGER])('withholds modern, legacy and referenced capabilities from %s', async (userId) => {
    const feed = await globalFeed(userId);
    expect(feed.comments.map((comment) => comment.uuid)).toContain(BOARD_COMMENTS[0].uuid);
    const serialized = JSON.stringify(feed);
    for (const hidden of [LEGACY_BOARD, MODERN_BOARD, REFERENCE_COMMENT]) expect(serialized).not.toContain(hidden);
  });

  it.each([OWNER, MEMBER])('keeps already-authorized board discussions discoverable to %s', async (userId) => {
    expect((await globalFeed(userId)).comments.map((comment) => comment.uuid)).toEqual(
      expect.arrayContaining([...BOARD_COMMENTS.map((comment) => comment.uuid), REFERENCE_COMMENT]),
    );
  });

  it('applies the no-link rule through materialized comment references', async () => {
    const feed = await activityFeedQueries.activityFeed(null, { input: { limit: 50 } }, viewer(STRANGER));
    const commentIds = feed.items.filter((item) => item.entityType === 'comment').map((item) => item.entityId);
    expect(commentIds).toContain(BOARD_COMMENTS[0].uuid);
    expect(commentIds).not.toContain(BOARD_COMMENTS[1].uuid);
    expect(commentIds).not.toContain(BOARD_COMMENTS[2].uuid);
    expect(commentIds).not.toContain(REFERENCE_COMMENT);
  });

  it('preserves direct-link threads for anonymous and signed-in link holders', async () => {
    for (const userId of [null, STRANGER]) {
      for (const comment of BOARD_COMMENTS.slice(1)) {
        const thread = await socialCommentQueries.comments(
          null,
          {
            input: { entityType: 'board', entityId: comment.entityId },
          },
          viewer(userId),
        );
        expect(thread.comments.map((entry) => entry.uuid)).toContain(comment.uuid);
      }
    }
  });

  it('withdraws a revoked member’s discovery while preserving the owner', async () => {
    await db
      .update(schema.resourceGrants)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(schema.resourceGrants.kind, 'board'),
          eq(schema.resourceGrants.resourceId, MODERN_BOARD),
          eq(schema.resourceGrants.userId, MEMBER),
        ),
      );
    try {
      expect(JSON.stringify(await globalFeed(MEMBER))).not.toContain(MODERN_BOARD);
      expect(JSON.stringify(await globalFeed(OWNER))).toContain(MODERN_BOARD);
    } finally {
      await db
        .update(schema.resourceGrants)
        .set({ status: 'approved' })
        .where(
          and(
            eq(schema.resourceGrants.kind, 'board'),
            eq(schema.resourceGrants.resourceId, MODERN_BOARD),
            eq(schema.resourceGrants.userId, MEMBER),
          ),
        );
    }
  });
});
