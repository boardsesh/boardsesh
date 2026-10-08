import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { tickQueries } from '../graphql/resolvers/ticks/queries';
import { socialCommentQueries } from '../graphql/resolvers/social/comments';
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
    .values([owner, approved, stranger].map((id) => ({ id, email: `${id}@test.com`, name: id })));
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
  it('protects a deleted public reply under a private ancestor', async () => {
    const [reply] = await db.select().from(schema.comments).where(eq(schema.comments.uuid, 'privacy-reply'));
    expect(await canReadDeletedComment(reply.uuid, stranger, reply.parentCommentId, null)).toBe(false);
    expect(await canReadDeletedComment(reply.uuid, stranger, reply.parentCommentId, approved)).toBe(true);
  });
  it('keeps every own tick available, including restricted containers', async () => {
    expect(await visibleTicks(owner)).toEqual([...tickIds].sort());
  });
  it('allows accepted followers but excludes only-me and unapproved sessions', async () => {
    expect(await visibleTicks(approved)).toEqual(['privacy-normal', 'privacy-public', 'privacy-stale-public']);
  });
  it('does not grant access to pending requests or anonymous viewers', async () => {
    expect(await visibleTicks(stranger)).toEqual(['privacy-public', 'privacy-session']);
    expect(await visibleTicks()).toEqual(['privacy-public']);
  });
  it('checks private comments and their ancestors before exposing replies', async () => {
    const comments = await db
      .select({ uuid: schema.comments.uuid })
      .from(schema.comments)
      .where(commentPrivacyCondition(stranger));
    expect(comments).toEqual([]);
    expect(await canReadSocialEntity('comment', 'privacy-parent', stranger)).toBe(false);
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
    expect(await canReadSocialEntity('comment', 'privacy-chain-private', stranger)).toBe(false);
    expect(await canReadSocialEntity('comment', 'privacy-chain-private', approved)).toBe(true);
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
    const notification = alias(schema.notifications, 'privacy_test_notice');
    const [result] = await db.select({ allowed: notificationPrivacyCondition(stranger, notification) })
      .from(sql`(SELECT 'comment_reply'::text AS type, ${stranger}::text AS actor_id, ${reply.id}::integer AS comment_id,
        'climb'::text AS entity_type, ${climbUuid}::text AS entity_id) privacy_test_notice`);
    expect(result.allowed).toBe(false);
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
    expect(await visibleTicks(approved)).toEqual(['privacy-public']);
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
