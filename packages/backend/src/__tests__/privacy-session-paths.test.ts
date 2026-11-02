import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { resourceAccessCondition, sessionBoardLocationCondition } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { canAccessResource, canAccessResourceWithoutLink } from '../services/privacy';
import { projectSessionBoardPath } from '../services/board-session-privacy';
import { roomManager } from '../services/room-manager';

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

// #7013: a session on a wall at an unlisted gym handed every joiner the board's
// geometry instead of its name, so each joiner climbed on a private board of
// their own. A gym's listing keeps it out of discovery; it does not hide the
// wall from the crew climbing on it. Everything else that withholds the name
// still does.
describe('named session paths at gyms', () => {
  const gymOwnerId = 'gym-path-gym-owner';
  const gymEditorId = 'gym-path-gym-editor';
  const gymMemberId = 'gym-path-gym-member';
  const strangerId = 'gym-path-stranger';
  const geometry = '/kilter/1/1/1/40';
  const named = (slug: string) => `/b/${slug}/40`;

  beforeAll(async () => {
    await db
      .insert(schema.users)
      .values(
        [gymOwnerId, gymEditorId, gymMemberId, strangerId].map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
      );
    const insertGym = async (name: string, values: Partial<typeof schema.gyms.$inferInsert>) => {
      const [gym] = await db
        .insert(schema.gyms)
        .values({ uuid: `gym-path-${name}`, name, ownerId: gymOwnerId, ...values })
        .returning({ id: schema.gyms.id });
      return Number(gym.id);
    };
    const unlistedGymId = await insertGym('unlisted', { isPublic: true, isListed: false });
    const privateGymId = await insertGym('private', { isPublic: false });
    const deletedGymId = await insertGym('deleted', { isPublic: true, deletedAt: new Date() });
    const listedGymId = await insertGym('listed', { isPublic: true, isListed: true });
    await db.insert(schema.gymMembers).values([
      { gymId: privateGymId, userId: gymEditorId, role: 'editor' },
      // A plain member does not see a private gym (`gymVisibleCondition`).
      { gymId: privateGymId, userId: gymMemberId, role: 'member' },
    ]);
    const gymBoard = (slug: string, gymId: number, values: Partial<typeof schema.userBoards.$inferInsert> = {}) => ({
      uuid: `${slug}-board`,
      slug,
      ownerId,
      name: slug,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      angle: 40,
      isPublic: true,
      gymId,
      ...values,
    });
    await db
      .insert(schema.userBoards)
      .values([
        gymBoard('unlisted-gym-public', unlistedGymId),
        gymBoard('unlisted-gym-unlisted-board', unlistedGymId, { isUnlisted: true }),
        gymBoard('private-gym-public', privateGymId),
        gymBoard('deleted-gym-public', deletedGymId),
        gymBoard('listed-gym-public', listedGymId),
      ]);
  });

  it('names a public wall at an unlisted gym to the crew who joined', async () => {
    expect(await projectSessionBoardPath(named('unlisted-gym-public'), strangerId)).toBe(named('unlisted-gym-public'));
    expect(await projectSessionBoardPath(named('unlisted-gym-public'), gymOwnerId)).toBe(named('unlisted-gym-public'));
    expect(await projectSessionBoardPath(named('unlisted-gym-public'), ownerId)).toBe(named('unlisted-gym-public'));
    // Signed out, the invite still holds the session.
    expect(await projectSessionBoardPath(named('unlisted-gym-public'), null)).toBe(named('unlisted-gym-public'));
  });

  it('keeps a wall at an unlisted gym unnamed in nearby sessions, which are discovery', async () => {
    const latitude = 51.5;
    const longitude = -0.12;
    const sessionId = 'gym-path-nearby';
    await roomManager.createDiscoverableSession(
      sessionId,
      named('unlisted-gym-public'),
      ownerId,
      latitude,
      longitude,
      'Board night',
    );
    await roomManager.registerClient('gym-path-nearby-host', 'Host', ownerId);
    await roomManager.joinSession('gym-path-nearby-host', sessionId, named('unlisted-gym-public'));
    const nearbyPath = async (viewerId: string | undefined) =>
      (await roomManager.findNearbySessions(latitude, longitude, 10_000, viewerId)).find(
        (session) => session.id === sessionId,
      )?.boardPath;

    expect(await nearbyPath(strangerId)).toBe(geometry);
    expect(await nearbyPath(undefined)).toBe(geometry);
    // The gym's own people and the wall's owner still see which wall it is.
    expect(await nearbyPath(gymOwnerId)).toBe(named('unlisted-gym-public'));
    expect(await nearbyPath(ownerId)).toBe(named('unlisted-gym-public'));
  });

  it('keeps a public wall at a listed gym named', async () => {
    expect(await projectSessionBoardPath(named('listed-gym-public'), strangerId)).toBe(named('listed-gym-public'));
  });

  it('withholds an unlisted wall from anyone who does not hold it: an invite is not its link', async () => {
    expect(await projectSessionBoardPath(named('unlisted-gym-unlisted-board'), strangerId)).toBe(geometry);
    expect(await projectSessionBoardPath(named('unlisted-gym-unlisted-board'), ownerId)).toBe(
      named('unlisted-gym-unlisted-board'),
    );
  });

  it('names a wall at a private gym only to the board owner and the people who can see the gym', async () => {
    expect(await projectSessionBoardPath(named('private-gym-public'), ownerId)).toBe(named('private-gym-public'));
    expect(await projectSessionBoardPath(named('private-gym-public'), gymOwnerId)).toBe(named('private-gym-public'));
    expect(await projectSessionBoardPath(named('private-gym-public'), gymEditorId)).toBe(named('private-gym-public'));
    expect(await projectSessionBoardPath(named('private-gym-public'), gymMemberId)).toBe(geometry);
    expect(await projectSessionBoardPath(named('private-gym-public'), strangerId)).toBe(geometry);
    expect(await projectSessionBoardPath(named('private-gym-public'), null)).toBe(geometry);
  });

  it('withholds a wall whose gym was deleted', async () => {
    expect(await projectSessionBoardPath(named('deleted-gym-public'), strangerId)).toBe(geometry);
    expect(await projectSessionBoardPath(named('deleted-gym-public'), ownerId)).toBe(named('deleted-gym-public'));
  });

  it('withholds an admin-hidden spray wall from everyone but its owner', async () => {
    const sprayGeometry = `/spray/${hiddenSprayLayoutId}/${hiddenSprayLayoutId}/1/40`;
    expect(await projectSessionBoardPath(named('privacy-hidden-spray'), strangerId)).toBe(sprayGeometry);
    expect(await projectSessionBoardPath(named('privacy-hidden-spray'), null)).toBe(sprayGeometry);
    expect(await projectSessionBoardPath(named('privacy-hidden-spray'), ownerId)).toBe(named('privacy-hidden-spray'));
  });
});
