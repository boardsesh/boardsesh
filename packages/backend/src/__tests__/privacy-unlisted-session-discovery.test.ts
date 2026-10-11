/**
 * Real-DB coverage for unlisted sessions on discovery surfaces. A legacy
 * `is_public = false` session is unlisted: anyone holding its link reads its
 * thread, but its id is that link, so a comment on it never reaches the global
 * comment feed or the activity feed of someone outside its host and roster.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { activityFeedQueries } from '../graphql/resolvers/social/activity-feed';
import { canReadSocialEntity } from '../graphql/resolvers/shared/activity-privacy';

const HOST = 'unlisted-discovery-host';
const ROSTER = 'unlisted-discovery-roster';
const COMMENTER = 'unlisted-discovery-commenter';
const STRANGER = 'unlisted-discovery-stranger';

const LEGACY_SESSION = 'unlisted-discovery-legacy-session';
const OVERRIDE_SESSION = 'unlisted-discovery-override-session';
const PUBLIC_SESSION = 'unlisted-discovery-public-session';

const LEGACY_COMMENT = '6f2d6c84-0d8c-4c41-9d5e-0a8f1f6d1001';
const OVERRIDE_COMMENT = '6f2d6c84-0d8c-4c41-9d5e-0a8f1f6d1002';
const PUBLIC_COMMENT = '6f2d6c84-0d8c-4c41-9d5e-0a8f1f6d1003';

const viewer = (userId: string | null): ConnectionContext =>
  ({ connectionId: `unlisted-discovery-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

async function globalFeedCommentIds(userId: string | null): Promise<string[]> {
  const feed = await socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, viewer(userId));
  return feed.comments.map((comment) => comment.uuid);
}

async function activityFeedCommentIds(userId: string): Promise<string[]> {
  const feed = await activityFeedQueries.activityFeed(null, { input: { limit: 50 } }, viewer(userId));
  return feed.items.filter((item) => item.entityType === 'comment').map((item) => item.entityId);
}

async function threadCommentIds(sessionId: string, userId: string | null): Promise<string[]> {
  const thread = await socialCommentQueries.comments(
    null,
    { input: { entityType: 'session', entityId: sessionId } },
    viewer(userId),
  );
  return thread.comments.map((comment) => comment.uuid);
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([HOST, ROSTER, COMMENTER, STRANGER].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  // Everyone follows the commenter, so the comment fans out to all three.
  await db
    .insert(dbSchema.userFollows)
    .values([HOST, ROSTER, STRANGER].map((followerId) => ({ followerId, followingId: COMMENTER })));
  await db.insert(dbSchema.comments).values([
    { uuid: LEGACY_COMMENT, userId: COMMENTER, entityType: 'session', entityId: LEGACY_SESSION, body: 'Legacy' },
    { uuid: OVERRIDE_COMMENT, userId: COMMENTER, entityType: 'session', entityId: OVERRIDE_SESSION, body: 'Link' },
    { uuid: PUBLIC_COMMENT, userId: COMMENTER, entityType: 'session', entityId: PUBLIC_SESSION, body: 'Public' },
  ]);
  // The materialized feed points at the comment; the privacy chain walks up to its session.
  await db.insert(dbSchema.feedItems).values(
    [HOST, ROSTER, STRANGER].flatMap((recipientId) =>
      [LEGACY_COMMENT, OVERRIDE_COMMENT, PUBLIC_COMMENT].map((entityId) => ({
        recipientId,
        actorId: COMMENTER,
        type: 'comment' as const,
        entityType: 'comment' as const,
        entityId,
        metadata: {},
      })),
    ),
  );
  await db.insert(dbSchema.resourcePrivacy).values({
    kind: 'session',
    resourceId: OVERRIDE_SESSION,
    ownerId: HOST,
    audience: 'unlisted',
  });
});

// The shared setup truncates sessions and rosters before every test.
beforeEach(async () => {
  await db.insert(dbSchema.boardSessions).values([
    { id: LEGACY_SESSION, boardPath: '/kilter/1/10/1/40', createdByUserId: HOST, isPublic: false, status: 'ended' },
    { id: OVERRIDE_SESSION, boardPath: '/kilter/1/10/1/40', createdByUserId: HOST, isPublic: true, status: 'ended' },
    { id: PUBLIC_SESSION, boardPath: '/kilter/1/10/1/40', createdByUserId: HOST, isPublic: true, status: 'ended' },
  ]);
  await db
    .insert(dbSchema.boardSessionParticipants)
    .values([LEGACY_SESSION, OVERRIDE_SESSION].map((sessionId) => ({ sessionId, userId: ROSTER })));
});

describe('unlisted sessions on discovery surfaces', () => {
  it('keeps a public comment on a legacy private session off the global comment feed for outsiders', async () => {
    for (const outsider of [STRANGER, null]) {
      const ids = await globalFeedCommentIds(outsider);
      expect(ids).toContain(PUBLIC_COMMENT);
      expect(ids).not.toContain(LEGACY_COMMENT);
      expect(ids).not.toContain(OVERRIDE_COMMENT);
    }
    for (const member of [HOST, ROSTER]) {
      expect(await globalFeedCommentIds(member)).toEqual(
        expect.arrayContaining([LEGACY_COMMENT, OVERRIDE_COMMENT, PUBLIC_COMMENT]),
      );
    }
  });

  it('keeps it out of a stranger’s activity feed, and in the host’s and roster’s', async () => {
    const strangerIds = await activityFeedCommentIds(STRANGER);
    expect(strangerIds).toContain(PUBLIC_COMMENT);
    expect(strangerIds).not.toContain(LEGACY_COMMENT);
    expect(strangerIds).not.toContain(OVERRIDE_COMMENT);
    for (const member of [HOST, ROSTER]) {
      expect(await activityFeedCommentIds(member)).toEqual(
        expect.arrayContaining([LEGACY_COMMENT, OVERRIDE_COMMENT, PUBLIC_COMMENT]),
      );
    }
  });

  it('still opens the session’s own thread for anyone holding its link', async () => {
    for (const reader of [STRANGER, null, HOST, ROSTER]) {
      expect(await threadCommentIds(LEGACY_SESSION, reader)).toEqual([LEGACY_COMMENT]);
      expect(await threadCommentIds(OVERRIDE_SESSION, reader)).toEqual([OVERRIDE_COMMENT]);
    }
    expect(await canReadSocialEntity('comment', LEGACY_COMMENT, STRANGER)).toBe(true);
    expect(await canReadSocialEntity('session', LEGACY_SESSION, null)).toBe(true);
  });

  it('keeps an Invite-only session’s comment out of discovery and its thread closed to strangers', async () => {
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: PUBLIC_SESSION,
      ownerId: HOST,
      audience: 'invite_only',
    });
    try {
      expect(await globalFeedCommentIds(STRANGER)).not.toContain(PUBLIC_COMMENT);
      expect(await threadCommentIds(PUBLIC_SESSION, STRANGER)).toEqual([]);
      expect(await globalFeedCommentIds(HOST)).toContain(PUBLIC_COMMENT);
    } finally {
      await db
        .delete(dbSchema.resourcePrivacy)
        .where(
          and(eq(dbSchema.resourcePrivacy.kind, 'session'), eq(dbSchema.resourcePrivacy.resourceId, PUBLIC_SESSION)),
        );
    }
  });
});
