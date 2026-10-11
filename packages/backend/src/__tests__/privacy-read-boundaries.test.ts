import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as schema from '@boardsesh/db/schema';
import { contentVisibilityCondition } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { tickQueries } from '../graphql/resolvers/ticks/queries';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  betaPrivacyCondition,
  canReadSocialEntity,
  canReadDeletedComment,
  commentPrivacyCondition,
  notificationPrivacyCondition,
  tickPrivacyCondition,
} from '../graphql/resolvers/shared/activity-privacy';

const owner = 'privacy-matrix-owner';
const approved = 'privacy-matrix-approved';
const stranger = 'privacy-matrix-stranger';
// Never comments, follows or owns anything: the reader every exemption skips.
const bystander = 'privacy-matrix-bystander';
const climbUuid = 'privacy-matrix-catalog-climb';
const sessionId = 'privacy-matrix-session';
const tickIds = ['privacy-normal', 'privacy-only-me', 'privacy-public', 'privacy-stale-public', 'privacy-session'];

async function visibleTicks(viewer?: string) {
  const rows = await db
    .select({ uuid: schema.boardseshTicks.uuid })
    .from(schema.boardseshTicks)
    .where(and(eq(schema.boardseshTicks.userId, owner), tickPrivacyCondition(viewer)))
    .orderBy(schema.boardseshTicks.uuid);
  return rows.map((row) => row.uuid);
}

beforeAll(async () => {
  await db
    .insert(schema.users)
    .values([owner, approved, stranger, bystander].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  await db.insert(schema.userProfiles).values({ userId: owner, isPrivate: true, privacyRevision: 2 });
  await db.insert(schema.userFollows).values({ followerId: approved, followingId: owner });
  await db.insert(schema.userFollowRequests).values({ requesterId: stranger, recipientId: owner });
  await db.insert(schema.boardClimbs).values({
    uuid: climbUuid,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Public catalog',
    isListed: true,
    isDraft: false,
    frames: 'p1r1',
  });
  await db
    .insert(schema.boardSessions)
    .values({ id: sessionId, boardPath: 'kilter/1/1/1/40', createdByUserId: stranger, isPublic: true });
  await db
    .insert(schema.resourcePrivacy)
    .values({ kind: 'session', resourceId: sessionId, ownerId: stranger, audience: 'invite_only' });
  await db.insert(schema.boardseshTicks).values(
    tickIds.map((uuid) => ({
      uuid,
      userId: owner,
      climbUuid,
      boardType: 'kilter',
      angle: 40,
      status: 'send' as const,
      difficulty: 15,
      climbedAt: '2026-01-01T10:00:00Z',
      sessionId: uuid === 'privacy-session' ? sessionId : null,
    })),
  );
  await db.insert(schema.contentPrivacy).values([
    { entityType: 'tick', entityId: 'privacy-only-me', ownerId: owner, audience: 'only_me' },
    { entityType: 'tick', entityId: 'privacy-public', ownerId: owner, audience: 'public', publicConsentRevision: 2 },
    {
      entityType: 'tick',
      entityId: 'privacy-stale-public',
      ownerId: owner,
      audience: 'public',
      publicConsentRevision: 1,
    },
    { entityType: 'tick', entityId: 'privacy-session', ownerId: owner, audience: 'public', publicConsentRevision: 2 },
  ]);
  const [parent] = await db
    .insert(schema.comments)
    .values({ uuid: 'privacy-parent', userId: owner, entityType: 'climb', entityId: climbUuid, body: 'Private parent' })
    .returning();
  await db.insert(schema.comments).values({
    uuid: 'privacy-reply',
    userId: stranger,
    entityType: 'climb',
    entityId: climbUuid,
    parentCommentId: parent.id,
    body: 'Public reply',
  });
});

// The backend harness clears live sessions before each case.
beforeEach(async () => {
  await db
    .insert(schema.boardSessions)
    .values({
      id: sessionId,
      boardPath: 'kilter/1/1/1/40',
      createdByUserId: stranger,
      isPublic: true,
    })
    .onConflictDoNothing();
});

describe('SQL privacy boundaries against Postgres', () => {
  it('keeps a deleted reply under a private ancestor from strangers, but not from its author', async () => {
    const [reply] = await db.select().from(schema.comments).where(eq(schema.comments.uuid, 'privacy-reply'));
    const tombstone = {
      commentUuid: reply.uuid,
      authorUserId: stranger,
      parentCommentId: reply.parentCommentId,
      entityType: 'climb',
      entityId: climbUuid,
    };
    expect(await canReadDeletedComment(tombstone, null)).toBe(false);
    expect(await canReadDeletedComment(tombstone, bystander)).toBe(false);
    expect(await canReadDeletedComment(tombstone, approved)).toBe(true);
    // Whoever replied reads the thread they replied in.
    expect(await canReadDeletedComment(tombstone, stranger)).toBe(true);
  });
  it('keeps every own tick available to its author', async () => {
    expect(await visibleTicks(owner)).toEqual([...tickIds].sort());
  });
  it('shows accepted followers what the author allows, whatever session a tick was logged in', async () => {
    // privacy-session sits in somebody else's invite-only session the follower
    // was never invited to. The tick follows its author, not that session.
    expect(await visibleTicks(approved)).toEqual([
      'privacy-normal',
      'privacy-public',
      'privacy-session',
      'privacy-stale-public',
    ]);
  });
  it('gives pending requests and anonymous viewers only the author’s current public consent', async () => {
    expect(await visibleTicks(stranger)).toEqual(['privacy-public', 'privacy-session']);
    expect(await visibleTicks()).toEqual(['privacy-public', 'privacy-session']);
  });
  it('checks private comments and their ancestors before exposing replies', async () => {
    const readableBy = async (viewerId: string | null) =>
      (
        await db
          .select({ uuid: schema.comments.uuid })
          .from(schema.comments)
          .where(commentPrivacyCondition(viewerId))
          .orderBy(schema.comments.uuid)
      ).map((row) => row.uuid);
    expect(await readableBy(null)).toEqual([]);
    expect(await readableBy(bystander)).toEqual([]);
    // The reply's author reads the private comment they replied to.
    expect(await readableBy(stranger)).toEqual(['privacy-parent', 'privacy-reply']);
    expect(await canReadSocialEntity('comment', 'privacy-parent', bystander)).toBe(false);
    expect(await canReadSocialEntity('comment', 'privacy-parent', stranger)).toBe(true);
    expect(await canReadSocialEntity('comment', 'privacy-reply', approved)).toBe(true);
    expect(await canReadSocialEntity('climb', climbUuid, undefined)).toBe(true);
  });
  it('bounds referenced-comment chains and checks every intermediate audience', async () => {
    await db.insert(schema.comments).values([
      { uuid: 'privacy-chain-terminal', userId: stranger, entityType: 'climb', entityId: climbUuid, body: 'Public' },
      {
        uuid: 'privacy-chain-two',
        userId: stranger,
        entityType: 'comment',
        entityId: 'privacy-chain-terminal',
        body: 'Two hops',
      },
      {
        uuid: 'privacy-chain-three',
        userId: stranger,
        entityType: 'comment',
        entityId: 'privacy-chain-two',
        body: 'Too deep',
      },
      {
        uuid: 'privacy-chain-private',
        userId: owner,
        entityType: 'comment',
        entityId: 'privacy-chain-terminal',
        body: 'Private intermediate',
      },
      {
        uuid: 'privacy-chain-inner-private',
        userId: owner,
        entityType: 'climb',
        entityId: climbUuid,
        body: 'Private target',
      },
      {
        uuid: 'privacy-chain-public-outer',
        userId: stranger,
        entityType: 'comment',
        entityId: 'privacy-chain-inner-private',
        body: 'Public outer',
      },
      {
        uuid: 'privacy-chain-cycle',
        userId: stranger,
        entityType: 'comment',
        entityId: 'privacy-chain-cycle',
        body: 'Cycle',
      },
    ]);
    expect(await canReadSocialEntity('comment', 'privacy-chain-two', null)).toBe(true);
    expect(await canReadSocialEntity('comment', 'privacy-chain-three', null)).toBe(false);
    expect(await canReadSocialEntity('comment', 'privacy-chain-private', bystander)).toBe(false);
    expect(await canReadSocialEntity('comment', 'privacy-chain-private', approved)).toBe(true);
    // A comment on the stranger's own comment is the stranger's to read.
    expect(await canReadSocialEntity('comment', 'privacy-chain-private', stranger)).toBe(true);
    expect(await canReadSocialEntity('comment', 'privacy-chain-public-outer', stranger)).toBe(false);
    expect(await canReadSocialEntity('comment', 'privacy-chain-public-outer', approved)).toBe(true);
    expect(await canReadSocialEntity('comment', 'privacy-chain-cycle', stranger)).toBe(false);
    expect(await canReadSocialEntity('comment', 'privacy-chain-missing', stranger)).toBe(false);
  });
  it('filters the global comment page without changing database JIT defaults', async () => {
    const settingsBefore = await db.execute(sql`SELECT current_setting('jit') AS jit`);
    await db.insert(schema.comments).values({
      uuid: 'privacy-global-public',
      userId: stranger,
      entityType: 'climb',
      entityId: climbUuid,
      body: 'Public page fixture',
    });
    const result = await socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, {
      userId: null,
      isAuthenticated: false,
      connectionId: 'privacy-global-test',
    } as unknown as ConnectionContext);
    const commentIds = result.comments.map((comment) => comment.uuid);
    expect(commentIds).toContain('privacy-global-public');
    expect(commentIds).not.toContain('privacy-parent');
    expect(commentIds).not.toContain('privacy-reply');
    expect(await db.execute(sql`SELECT current_setting('jit') AS jit`)).toEqual(settingsBefore);
  });
  it('hides a tick-linked beta URL when its tick is only-me', async () => {
    await db.insert(schema.boardBetaLinks).values({
      boardType: 'kilter',
      climbUuid,
      link: 'https://www.instagram.com/p/privacy/',
      createdByUserId: owner,
      tickUuid: 'privacy-only-me',
      isListed: true,
    });
    const rows = await db
      .select({ link: schema.boardBetaLinks.link })
      .from(schema.boardBetaLinks)
      .where(betaPrivacyCondition(approved));
    expect(rows).toEqual([]);
  });
  it('rechecks notification references without exposing private replies', async () => {
    const [reply] = await db.select().from(schema.comments).where(eq(schema.comments.uuid, 'privacy-reply'));
    await db.insert(schema.notifications).values({
      uuid: 'privacy-enum-reply-notification',
      recipientId: stranger,
      actorId: stranger,
      type: 'comment_reply',
      commentId: reply.id,
      entityType: 'climb',
      entityId: climbUuid,
    });
    const notification = alias(schema.notifications, 'privacy_test_notice');
    for (const [viewerId, allowed] of [
      [owner, true],
      [approved, true],
      // The reply's own author is told about it, and reads it.
      [stranger, true],
      [bystander, false],
    ] as const) {
      const [result] = await db
        .select({ allowed: notificationPrivacyCondition(viewerId, notification) })
        .from(notification)
        .where(eq(notification.uuid, 'privacy-enum-reply-notification'));
      expect(result.allowed).toBe(allowed);
    }
    // The stranger can read it now; the inbox test below starts from empty inboxes.
    await db.delete(schema.notifications).where(eq(schema.notifications.uuid, 'privacy-enum-reply-notification'));
  });
  it('counts only readable unread notifications and applies the same policy to both inboxes', async () => {
    const [reply] = await db.select().from(schema.comments).where(eq(schema.comments.uuid, 'privacy-reply'));
    const otherRecipient = 'privacy-enum-other-recipient';
    await db.insert(schema.users).values({ id: otherRecipient, email: `${otherRecipient}@test.com` });
    for (const viewerId of [owner, approved, stranger]) {
      const context: ConnectionContext = { userId: viewerId, isAuthenticated: true, connectionId: viewerId };
      expect(await socialNotificationQueries.unreadNotificationCount(null, {}, context)).toBe(0);
    }
    const fixtures: Array<Omit<schema.NewNotification, 'uuid' | 'recipientId'>> = [
      { type: 'new_climb', actorId: stranger, entityType: 'climb', entityId: climbUuid },
      {
        type: 'new_climb',
        actorId: stranger,
        entityType: 'climb',
        entityId: climbUuid,
        readAt: new Date('2026-01-02T10:00:00Z'),
      },
      { type: 'vote_on_tick', actorId: owner, entityType: 'tick', entityId: 'privacy-normal' },
      { type: 'vote_on_tick', actorId: owner, entityType: 'tick', entityId: 'privacy-only-me' },
      { type: 'comment_reply', actorId: stranger, entityType: 'climb', entityId: climbUuid, commentId: reply.id },
      { type: 'vote_on_tick', actorId: null, entityType: 'tick', entityId: 'privacy-missing-tick' },
    ];
    await db.insert(schema.notifications).values([
      ...[owner, approved, stranger].flatMap((recipientId) =>
        fixtures.map((fixture, index) => ({
          ...fixture,
          uuid: `privacy-enum-${recipientId}-${index}`,
          recipientId,
          createdAt: new Date(`2026-01-01T10:00:0${index}Z`),
        })),
      ),
      { uuid: 'privacy-enum-other-notice', recipientId: otherRecipient, ...fixtures[0] },
    ]);
    for (const [viewerId, visibleIndexes] of [
      [owner, [0, 1, 2, 3, 4]],
      [approved, [0, 1, 2, 4]],
      // The comment_reply is about the stranger's own reply under a private parent.
      [stranger, [0, 1, 4]],
    ] as const) {
      const context: ConnectionContext = { userId: viewerId, isAuthenticated: true, connectionId: viewerId };
      const expectedIds = visibleIndexes.map((index) => `privacy-enum-${viewerId}-${index}`).sort();
      const expectedUnreadCount = visibleIndexes.length - 1;
      expect(await socialNotificationQueries.unreadNotificationCount(null, {}, context)).toBe(expectedUnreadCount);
      const inbox = await socialNotificationQueries.notifications(null, {}, context);
      expect(inbox.notifications.map((notification) => notification.uuid).sort()).toEqual(expectedIds);
      expect(inbox.totalCount).toBe(expectedIds.length);
      expect(inbox.unreadCount).toBe(expectedUnreadCount);
      const unreadInbox = await socialNotificationQueries.notifications(null, { unreadOnly: true }, context);
      expect(unreadInbox.notifications.map((notification) => notification.uuid).sort()).toEqual(
        expectedIds.filter((uuid) => uuid !== `privacy-enum-${viewerId}-1`),
      );
      expect(unreadInbox.totalCount).toBe(expectedIds.length);
      expect(unreadInbox.unreadCount).toBe(expectedUnreadCount);
      const groupedInbox = await socialNotificationQueries.groupedNotifications(null, {}, context);
      // The read and unread public notices form one group; every other row is distinct.
      expect(groupedInbox.groups.map((group) => group.uuid).sort()).toEqual(
        expectedIds.filter((uuid) => uuid !== `privacy-enum-${viewerId}-0`),
      );
      expect(groupedInbox.totalCount).toBe(expectedUnreadCount);
      expect(groupedInbox.unreadCount).toBe(expectedUnreadCount);
    }
  });
  it('checks enum-backed feed rows against content policies and retained orphan privacy', async () => {
    await db.insert(schema.contentPrivacy).values({
      entityType: 'tick',
      entityId: 'privacy-feed-orphan-private',
      ownerId: owner,
      audience: 'only_me',
    });
    const entityIds = [
      'privacy-normal',
      'privacy-only-me',
      'privacy-public',
      'privacy-stale-public',
      'privacy-feed-orphan-private',
      'privacy-feed-unowned-public',
    ];
    await db.insert(schema.feedItems).values(
      entityIds.map((entityId, index) => ({
        recipientId: owner,
        actorId: index < 4 ? owner : null,
        type: 'ascent' as const,
        entityType: 'tick' as const,
        entityId,
      })),
    );
    for (const [viewerId, expectedIds] of [
      [
        owner,
        ['privacy-normal', 'privacy-only-me', 'privacy-public', 'privacy-stale-public', 'privacy-feed-unowned-public'],
      ],
      [approved, ['privacy-normal', 'privacy-public', 'privacy-stale-public', 'privacy-feed-unowned-public']],
      [stranger, ['privacy-public', 'privacy-feed-unowned-public']],
      [undefined, ['privacy-public', 'privacy-feed-unowned-public']],
    ] as const) {
      const rows = await db
        .select({ entityId: schema.feedItems.entityId })
        .from(schema.feedItems)
        .where(
          and(
            eq(schema.feedItems.recipientId, owner),
            contentVisibilityCondition(
              schema.feedItems.entityType,
              schema.feedItems.entityId,
              schema.feedItems.actorId,
              viewerId,
            ),
          ),
        );
      expect(rows.map((row) => row.entityId).sort()).toEqual([...expectedIds].sort());
    }
  });
  it('keeps a public tick and beta inside an authored climb audience', async () => {
    const authoredClimb = 'privacy-authored-parent';
    await db.insert(schema.boardClimbs).values({
      uuid: authoredClimb,
      boardType: 'kilter',
      layoutId: 1,
      userId: owner,
      name: 'Private authored climb',
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
    });
    await db.insert(schema.boardseshTicks).values({
      uuid: 'privacy-public-on-private-climb',
      userId: approved,
      climbUuid: authoredClimb,
      boardType: 'kilter',
      angle: 40,
      status: 'send',
      climbedAt: '2026-01-01T10:00:00Z',
    });
    await db.insert(schema.boardBetaLinks).values({
      boardType: 'kilter',
      climbUuid: authoredClimb,
      link: 'https://www.instagram.com/p/private-parent/',
      createdByUserId: approved,
      isListed: true,
    });
    const ticks = await db
      .select({ uuid: schema.boardseshTicks.uuid })
      .from(schema.boardseshTicks)
      .where(and(eq(schema.boardseshTicks.climbUuid, authoredClimb), tickPrivacyCondition(stranger)));
    const beta = await db
      .select({ link: schema.boardBetaLinks.link })
      .from(schema.boardBetaLinks)
      .where(and(eq(schema.boardBetaLinks.climbUuid, authoredClimb), betaPrivacyCondition(stranger)));
    expect(ticks).toEqual([]);
    expect(beta).toEqual([]);
    const [aggregate] = await db
      .select({ count: count() })
      .from(schema.boardseshTicks)
      .where(eq(schema.boardseshTicks.climbUuid, authoredClimb));
    expect(aggregate.count).toBe(1);
  });
  it('does not expose private linked climbs through playlist discussions or draft proposals', async () => {
    const [playlist] = await db
      .insert(schema.playlists)
      .values({ uuid: 'privacy-discussion-playlist', boardType: 'kilter', name: 'Public playlist', isPublic: true })
      .returning();
    await db.insert(schema.playlistOwnership).values({ playlistId: playlist.id, userId: approved, role: 'owner' });
    await db.insert(schema.playlistClimbs).values({ playlistId: playlist.id, climbUuid: 'privacy-authored-parent' });
    expect(await canReadSocialEntity('playlist_climb', 'privacy-discussion-playlist:_all', stranger)).toBe(true);
    expect(
      await canReadSocialEntity('playlist_climb', 'privacy-discussion-playlist:privacy-authored-parent', stranger),
    ).toBe(false);
    await db.insert(schema.boardClimbs).values({
      uuid: 'privacy-proposal-draft',
      boardType: 'kilter',
      layoutId: 1,
      userId: approved,
      name: 'Draft',
      isListed: true,
      isDraft: true,
      frames: 'p1r1',
    });
    await db.insert(schema.climbProposals).values({
      uuid: 'privacy-draft-proposal',
      boardType: 'kilter',
      climbUuid: 'privacy-proposal-draft',
      proposerId: approved,
      type: 'grade',
      proposedValue: '15',
      currentValue: '14',
    });
    expect(await canReadSocialEntity('proposal', 'privacy-draft-proposal', stranger)).toBe(false);
  });
  it('revokes an accepted follower immediately while preserving aggregate contributions', async () => {
    await db
      .delete(schema.userFollows)
      .where(and(eq(schema.userFollows.followerId, approved), eq(schema.userFollows.followingId, owner)));
    expect(await visibleTicks(approved)).toEqual(['privacy-public', 'privacy-session']);
    const viewer = { isAuthenticated: true, userId: approved } as ConnectionContext;
    const ownTicks = (await tickQueries.userTicks(null, { userId: approved, boardType: 'kilter' }, viewer)) as Array<{
      uuid: string;
      layoutId: number | null;
    }>;
    expect(ownTicks).toContainEqual(
      expect.objectContaining({ uuid: 'privacy-public-on-private-climb', layoutId: null }),
    );
    const ownCounts = await tickQueries.userTickCountsByBoard(null, { userId: approved }, viewer);
    expect(ownCounts).toContainEqual(expect.objectContaining({ boardType: 'kilter', count: 1 }));
    const ownStats = await tickQueries.userProfileStats(null, { userId: approved }, viewer);
    expect(ownStats.totalDistinctClimbs).toBe(1);
    expect(ownStats.layoutStats).toContainEqual(expect.objectContaining({ boardType: 'kilter', layoutId: null }));
    const enriched = await db
      .select({ uuid: schema.boardseshTicks.uuid })
      .from(schema.boardseshTicks)
      .where(and(eq(schema.boardseshTicks.uuid, 'privacy-public-on-private-climb'), tickPrivacyCondition(approved)));
    expect(enriched).toEqual([]);
    const [aggregate] = await db
      .select({ count: count() })
      .from(schema.boardseshTicks)
      .where(eq(schema.boardseshTicks.climbUuid, climbUuid));
    expect(aggregate.count).toBe(5);
  });
});

describe('complete comment ancestry', () => {
  it.each([false, true])(
    'keeps surviving replies readable after an ancestor account disappears (nested: %s)',
    async (nested) => {
      const deletedAuthor = `privacy-deleted-ancestor-${nested}`;
      await db.insert(schema.users).values({ id: deletedAuthor, email: `${deletedAuthor}@test.com` });
      await db.insert(schema.userProfiles).values({ userId: deletedAuthor, isPrivate: true });
      await db.insert(schema.userFollows).values({ followerId: approved, followingId: deletedAuthor });
      const [root] = await db
        .insert(schema.comments)
        .values({
          uuid: `${deletedAuthor}-root`,
          userId: deletedAuthor,
          entityType: 'climb',
          entityId: climbUuid,
          body: 'Private context',
        })
        .returning();
      let replyParentId = root.id;
      if (nested) {
        const [middle] = await db
          .insert(schema.comments)
          .values({
            uuid: `${deletedAuthor}-middle`,
            userId: stranger,
            entityType: 'climb',
            entityId: climbUuid,
            parentCommentId: root.id,
            body: 'Public intermediate reply',
          })
          .returning();
        replyParentId = middle.id;
      }
      const [reply] = await db
        .insert(schema.comments)
        .values({
          uuid: `${deletedAuthor}-reply`,
          userId: stranger,
          entityType: 'climb',
          entityId: climbUuid,
          parentCommentId: replyParentId,
          body: 'Public reply retaining private context',
        })
        .returning();
      expect(await canReadSocialEntity('comment', reply.uuid, approved)).toBe(true);
      // The reply's author reads the thread they replied in; nobody else does.
      expect(await canReadSocialEntity('comment', reply.uuid, stranger)).toBe(true);
      expect(await canReadSocialEntity('comment', reply.uuid, bystander)).toBe(false);
      expect(await canReadSocialEntity('comment', reply.uuid, null)).toBe(false);

      // User deletion cascades to their comments, while reply parent IDs have no FK.
      await db.delete(schema.users).where(eq(schema.users.id, deletedAuthor));
      expect(await db.select().from(schema.comments).where(eq(schema.comments.id, root.id))).toEqual([]);
      const [survivingReply] = await db.select().from(schema.comments).where(eq(schema.comments.id, reply.id));
      expect(survivingReply.parentCommentId).toBe(replyParentId);
      // A missing ancestor is readable: the deleted account no longer orphans its subthread.
      for (const viewerId of [null, bystander, stranger, approved]) {
        expect(await canReadSocialEntity('comment', reply.uuid, viewerId)).toBe(true);
        expect(
          await canReadDeletedComment(
            {
              commentUuid: reply.uuid,
              authorUserId: stranger,
              parentCommentId: replyParentId,
              entityType: 'climb',
              entityId: climbUuid,
            },
            viewerId,
          ),
        ).toBe(true);
      }
      const feed = await socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, {
        userId: null,
        isAuthenticated: false,
        connectionId: `privacy-orphan-${nested}`,
      } as unknown as ConnectionContext);
      expect(feed.comments.map((comment) => comment.uuid)).toContain(reply.uuid);
    },
  );

  it('keeps each surviving reply on its own author’s privacy and audience after the ancestor is gone', async () => {
    // A missing ancestor stops blocking the chain, nothing more: the subthread is
    // not orphaned, and each reply under it reads exactly as it would under a
    // live public ancestor.
    const deletedAuthor = 'privacy-deleted-ancestor-audience';
    const privateReplier = 'privacy-surviving-private-replier';
    await db
      .insert(schema.users)
      .values([deletedAuthor, privateReplier].map((id) => ({ id, email: `${id}@test.com` })));
    await db
      .insert(schema.userProfiles)
      .values([deletedAuthor, privateReplier].map((userId) => ({ userId, isPrivate: true })));
    await db.insert(schema.userFollows).values({ followerId: approved, followingId: privateReplier });
    const [root] = await db
      .insert(schema.comments)
      .values({
        uuid: `${deletedAuthor}-root`,
        userId: deletedAuthor,
        entityType: 'climb',
        entityId: climbUuid,
        body: 'Thread starter',
      })
      .returning();
    const replies = {
      publicAccount: { uuid: `${deletedAuthor}-public-reply`, authorUserId: stranger },
      privateAccount: { uuid: `${deletedAuthor}-private-reply`, authorUserId: privateReplier },
      onlyMe: { uuid: `${deletedAuthor}-only-me-reply`, authorUserId: stranger },
    };
    await db.insert(schema.comments).values(
      Object.values(replies).map(({ uuid, authorUserId }) => ({
        uuid,
        userId: authorUserId,
        entityType: 'climb' as const,
        entityId: climbUuid,
        parentCommentId: root.id,
        body: 'Reply under a thread whose starter leaves',
      })),
    );
    await db
      .insert(schema.contentPrivacy)
      .values({ entityType: 'comment', entityId: replies.onlyMe.uuid, ownerId: stranger, audience: 'only_me' });

    await db.delete(schema.users).where(eq(schema.users.id, deletedAuthor));
    expect(await db.select().from(schema.comments).where(eq(schema.comments.id, root.id))).toEqual([]);

    const readers = async (reply: { uuid: string; authorUserId: string }) => {
      const allowed: string[] = [];
      for (const viewerId of [null, bystander, stranger, approved, privateReplier]) {
        const live = await canReadSocialEntity('comment', reply.uuid, viewerId);
        // The subscription's tombstone check for the same reply agrees with the live read.
        const tombstone = await canReadDeletedComment(
          {
            commentUuid: reply.uuid,
            authorUserId: reply.authorUserId,
            parentCommentId: root.id,
            entityType: 'climb',
            entityId: climbUuid,
          },
          viewerId,
        );
        expect(tombstone).toBe(live);
        if (live) allowed.push(viewerId ?? 'anonymous');
      }
      return allowed;
    };

    // A public account's reply: everyone, as under a live public ancestor.
    expect(await readers(replies.publicAccount)).toEqual(['anonymous', bystander, stranger, approved, privateReplier]);
    // A private account's reply: its author and accepted followers. The stranger
    // replied beside it under the same deleted root and still does not read it.
    expect(await readers(replies.privateAccount)).toEqual([approved, privateReplier]);
    // A public account's Only-me reply: its author alone.
    expect(await readers(replies.onlyMe)).toEqual([stranger]);

    const feed = await socialCommentQueries.globalCommentFeed(null, { input: { limit: 50 } }, {
      userId: null,
      isAuthenticated: false,
      connectionId: 'privacy-orphan-audience',
    } as unknown as ConnectionContext);
    const anonymousFeed = feed.comments.map((comment) => comment.uuid);
    expect(anonymousFeed).toContain(replies.publicAccount.uuid);
    expect(anonymousFeed).not.toContain(replies.privateAccount.uuid);
    expect(anonymousFeed).not.toContain(replies.onlyMe.uuid);
  });

  it('allows chains ending at a root or a missing row within 32 ancestors and rejects deeper chains and cycles', async () => {
    let parentCommentId: number | null = null;
    const chain = [];
    for (let depth = 0; depth <= 33; depth += 1) {
      const [comment]: Array<{ id: number; uuid: string }> = await db
        .insert(schema.comments)
        .values({
          uuid: `privacy-ancestor-depth-${depth}`,
          userId: stranger,
          entityType: 'climb',
          entityId: climbUuid,
          parentCommentId,
          body: 'Public chain',
        })
        .returning();
      chain.push(comment);
      parentCommentId = comment.id;
    }
    expect(await canReadSocialEntity('comment', chain[0].uuid, null)).toBe(true);
    expect(await canReadSocialEntity('comment', chain[32].uuid, null)).toBe(true);
    expect(await canReadSocialEntity('comment', chain[33].uuid, null)).toBe(false);

    // A missing row ends the chain like a root does: chain[33] now has 16 live ancestors.
    await db.delete(schema.comments).where(eq(schema.comments.id, chain[16].id));
    expect(await canReadSocialEntity('comment', chain[17].uuid, null)).toBe(true);
    expect(await canReadSocialEntity('comment', chain[33].uuid, null)).toBe(true);

    // A cycle reaches neither a root nor a missing row.
    await db.update(schema.comments).set({ parentCommentId: chain[1].id }).where(eq(schema.comments.id, chain[0].id));
    expect(await canReadSocialEntity('comment', chain[0].uuid, null)).toBe(false);
    expect(await canReadSocialEntity('comment', chain[15].uuid, null)).toBe(false);
    expect(await canReadSocialEntity('comment', chain[15].uuid, stranger)).toBe(false);
    expect(await canReadSocialEntity('comment', chain[33].uuid, null)).toBe(true);
  });
});
