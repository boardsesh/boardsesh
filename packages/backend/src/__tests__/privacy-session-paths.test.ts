import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { resourceAccessCondition, sessionBoardLocationCondition } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { canAccessResource, canAccessResourceWithoutLink } from '../services/privacy';

const ownerId = 'privacy-path-owner';
let publicBoardId: number;
let privateBoardId: number;
let hiddenSprayBoardId: number;
const hiddenSprayLayoutId = 987_654;

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, name: 'Owner', email: 'privacy-path-owner@test.invalid' });
  const boards = await db
    .insert(schema.userBoards)
    .values([
      {
        uuid: 'privacy-public-path-board',
        slug: 'privacy-public-path',
        ownerId,
        name: 'Public board',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: true,
      },
      {
        uuid: 'privacy-hidden-location-board',
        slug: 'privacy-hidden-location',
        ownerId,
        name: 'Hidden location',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: true,
        hideLocation: true,
      },
      {
        uuid: 'privacy-private-path-board',
        slug: 'privacy-private-path',
        ownerId,
        name: 'Private board',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        isPublic: false,
      },
    ])
    .returning({ id: schema.userBoards.id, slug: schema.userBoards.slug });
  publicBoardId = boards.find((board) => board.slug === 'privacy-public-path')!.id;
  privateBoardId = boards.find((board) => board.slug === 'privacy-private-path')!.id;
  // A public spray wall an admin has hidden.
  const [sprayBoard] = await db
    .insert(schema.userBoards)
    .values({
      uuid: 'privacy-hidden-spray-board',
      slug: 'privacy-hidden-spray',
      ownerId,
      name: 'Hidden spray wall',
      boardType: 'spray',
      layoutId: hiddenSprayLayoutId,
      sizeId: hiddenSprayLayoutId,
      setIds: '1',
      isPublic: true,
      hasLeds: false,
    })
    .returning({ id: schema.userBoards.id });
  hiddenSprayBoardId = sprayBoard.id;
  await db.insert(schema.sprayWalls).values({
    boardUuid: 'privacy-hidden-spray-board',
    layoutId: hiddenSprayLayoutId,
    hiddenAt: new Date(),
  });
});

beforeEach(async () => {
  await db.insert(schema.boardSessions).values(
    [
      { id: 'path-catalog', boardPath: 'kilter/1/1/1/40', boardId: null },
      { id: 'path-public', boardPath: '/b/privacy-public-path/40', boardId: null },
      { id: 'path-hidden-location', boardPath: '/b/privacy-hidden-location/40', boardId: null },
      { id: 'path-private', boardPath: 'b/privacy-private-path', boardId: null },
      { id: 'path-localized', boardPath: '//es//b//privacy-private-path/40/list', boardId: null },
      { id: 'path-stale-public-board', boardPath: 'b/privacy-private-path', boardId: publicBoardId },
      { id: 'path-private-board', boardPath: 'b/privacy-public-path', boardId: privateBoardId },
      { id: 'path-missing', boardPath: '/b/missing-private-wall', boardId: null },
      { id: 'path-spray-missing', boardPath: '/spray/999999999/1/1/40', boardId: null },
      {
        id: 'path-spray-hidden',
        boardPath: `/spray/${hiddenSprayLayoutId}/${hiddenSprayLayoutId}/1/40`,
        boardId: null,
      },
      { id: 'path-spray-hidden-bound', boardPath: 'kilter/1/1/1/40', boardId: hiddenSprayBoardId },
    ].map((session) => ({ ...session, isPublic: true, createdByUserId: ownerId })),
  );
});

describe('legacy session paths', () => {
  it('reads path-only and stale-board sessions by their own policy, without shadowing the outer session ID', async () => {
    // A legacy private session is unlisted: the link reads it, discovery does not.
    await db.update(schema.boardSessions).set({ isPublic: false }).where(eq(schema.boardSessions.id, 'path-private'));
    const readable = async (options?: { allowUnlistedLink: false }) =>
      (
        await db
          .select({ id: schema.boardSessions.id })
          .from(schema.boardSessions)
          .where(resourceAccessCondition('session', schema.boardSessions.id, null, options))
          .orderBy(schema.boardSessions.id)
      ).map((session) => session.id);
    const everySession = [
      'path-catalog',
      'path-hidden-location',
      'path-localized',
      'path-missing',
      'path-private',
      'path-private-board',
      'path-public',
      'path-spray-hidden',
      'path-spray-hidden-bound',
      'path-spray-missing',
      'path-stale-public-board',
    ];
    // Private, missing, hidden and stale boards never hide the session itself.
    expect(await readable()).toEqual(everySession);
    expect(await readable({ allowUnlistedLink: false })).toEqual(
      everySession.filter((sessionId) => sessionId !== 'path-private'),
    );
  });

  it('withholds location for a hidden or private wall, but not for a wall that no longer resolves', async () => {
    const visibleLocations = async (viewerId: string | null) =>
      (
        await db
          .select({ id: schema.boardSessions.id })
          .from(schema.boardSessions)
          .where(sessionBoardLocationCondition(schema.boardSessions.id, viewerId))
          .orderBy(schema.boardSessions.id)
      ).map((session) => session.id);
    expect(await visibleLocations(null)).toEqual(['path-catalog', 'path-missing', 'path-public', 'path-spray-missing']);
    expect(await visibleLocations(ownerId)).toContain('path-hidden-location');
    // An admin-hidden spray wall withholds its sessions' place, path-only or bound,
    // from everyone but the wall's owner.
    expect(await visibleLocations(ownerId)).toEqual(
      expect.arrayContaining(['path-spray-hidden', 'path-spray-hidden-bound']),
    );

    // A soft-deleted parent has no policy left to enforce.
    await db.update(schema.userBoards).set({ deletedAt: new Date() }).where(eq(schema.userBoards.id, privateBoardId));
    try {
      expect(await visibleLocations(null)).toEqual([
        'path-catalog',
        'path-localized',
        'path-missing',
        'path-private',
        'path-private-board',
        'path-public',
        'path-spray-missing',
        'path-stale-public-board',
      ]);
    } finally {
      await db.update(schema.userBoards).set({ deletedAt: null }).where(eq(schema.userBoards.id, privateBoardId));
    }
  });

  it('authorizes a session at runtime by its own policy, never its boards', async () => {
    expect(await canAccessResource('session', 'path-private', null)).toBe(true);
    expect(await canAccessResource('session', 'path-stale-public-board', null)).toBe(true);
    expect(await canAccessResource('session', 'path-private-board', null)).toBe(true);
    expect(await canAccessResource('session', 'path-missing', ownerId)).toBe(true);
    expect(await canAccessResource('session', 'path-public', null)).toBe(true);

    await db.update(schema.boardSessions).set({ isPublic: false }).where(eq(schema.boardSessions.id, 'path-private'));
    expect(await canAccessResource('session', 'path-private', null)).toBe(true);
    expect(await canAccessResourceWithoutLink('session', 'path-private', null)).toBe(false);
    expect(await canAccessResourceWithoutLink('session', 'path-private', ownerId)).toBe(true);
  });
});
