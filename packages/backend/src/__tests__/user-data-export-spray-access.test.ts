import { randomInt, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, inArray } from 'drizzle-orm';
import {
  boardClimbAliases,
  boardClimbs,
  boardseshTicks,
  gymMembers,
  gyms,
  playlistClimbs,
  playlistOwnership,
  playlists,
  sprayWalls,
  userBoards,
  userFavorites,
  users,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import { buildUserDataArchive } from '../services/user-data-export-archive';

const fixturePrefix = `export-spray-access-${randomUUID()}`;
const climberId = `${fixturePrefix}-climber`;
const wallOwnerId = `${fixturePrefix}-owner`;
const sharedBoardUuid = `${fixturePrefix}-shared-wall`;
const ownBoardUuid = `${fixturePrefix}-own-wall`;
const sharedLayoutId = randomInt(1000000000, 1900000000);
const ownLayoutId = sharedLayoutId + 1;
const sharedAuthoredUuid = `${fixturePrefix}-authored-on-shared-wall`;
const sharedOwnerClimbUuid = `${fixturePrefix}-wall-owner-climb`;
const aliasUuid = `${fixturePrefix}-wall-owner-alias`;
const ownClimbUuid = `${fixturePrefix}-own-private-wall-climb`;
const unresolvedUuid = `${fixturePrefix}-missing-climb`;
const playlistUuid = `${fixturePrefix}-playlist`;
const emptyPlaylistUuid = `${fixturePrefix}-empty-playlist`;
let gymId: number | null = null;

beforeEach(async () => {
  await db.insert(users).values([
    { id: climberId, email: `${climberId}@example.com`, name: 'Export climber' },
    { id: wallOwnerId, email: `${wallOwnerId}@example.com`, name: 'Wall owner' },
  ]);
  const [gym] = await db
    .insert(gyms)
    .values({ uuid: `${fixturePrefix}-gym`, name: 'Access fixture gym', ownerId: wallOwnerId })
    .returning({ id: gyms.id });
  gymId = gym.id;
  await db.insert(userBoards).values([
    {
      uuid: sharedBoardUuid,
      slug: sharedBoardUuid,
      ownerId: wallOwnerId,
      boardType: 'spray',
      layoutId: sharedLayoutId,
      sizeId: sharedLayoutId,
      setIds: '1',
      name: 'Shared wall',
      isPublic: true,
      gymId,
    },
    {
      uuid: ownBoardUuid,
      slug: ownBoardUuid,
      ownerId: climberId,
      boardType: 'spray',
      layoutId: ownLayoutId,
      sizeId: ownLayoutId,
      setIds: '1',
      name: 'My private wall',
      isPublic: false,
    },
  ]);
  await db.insert(sprayWalls).values([
    { boardUuid: sharedBoardUuid, layoutId: sharedLayoutId },
    { boardUuid: ownBoardUuid, layoutId: ownLayoutId },
  ]);
  await db.insert(boardClimbs).values([
    {
      uuid: sharedAuthoredUuid,
      boardType: 'spray',
      layoutId: sharedLayoutId,
      userId: climberId,
      name: 'Shared wall authored route',
      description: 'Shared wall secret description',
      frames: 'p666r3',
      isDraft: true,
    },
    {
      uuid: sharedOwnerClimbUuid,
      boardType: 'spray',
      layoutId: sharedLayoutId,
      userId: wallOwnerId,
      name: 'Shared wall owner route',
    },
    {
      uuid: ownClimbUuid,
      boardType: 'spray',
      layoutId: ownLayoutId,
      userId: climberId,
      name: 'Own private route',
      frames: 'p222r1',
      isDraft: true,
    },
  ]);
  await db
    .insert(boardClimbAliases)
    .values({ boardType: 'spray', aliasUuid, canonicalUuid: sharedOwnerClimbUuid, source: 'test' });
  const climbUuids = [aliasUuid, sharedAuthoredUuid, ownClimbUuid];
  await db.insert(boardseshTicks).values(
    climbUuids.map((climbUuid) => ({
      uuid: `${climbUuid}-tick`,
      userId: climberId,
      boardType: 'spray',
      climbUuid,
      status: 'send' as const,
      angle: 40,
      comment: 'Keep my personal note',
      isMirror: true,
      climbedAt: '2026-09-29T12:00:00Z',
    })),
  );
  await db
    .insert(userFavorites)
    .values(climbUuids.map((climbUuid) => ({ userId: climberId, boardName: 'spray', climbUuid, angle: 40 })));
  const ownedPlaylists = await db
    .insert(playlists)
    .values([
      { uuid: playlistUuid, boardType: 'spray', layoutId: sharedLayoutId, name: 'My projects' },
      { uuid: emptyPlaylistUuid, boardType: 'spray', name: 'My empty playlist' },
    ])
    .returning({ id: playlists.id, uuid: playlists.uuid });
  await db
    .insert(playlistOwnership)
    .values(ownedPlaylists.map((playlist) => ({ playlistId: playlist.id, userId: climberId, role: 'owner' })));
  const populatedPlaylist = ownedPlaylists.find((playlist) => playlist.uuid === playlistUuid)!;
  await db.insert(playlistClimbs).values(
    [...climbUuids, unresolvedUuid].map((climbUuid, position) => ({
      playlistId: populatedPlaylist.id,
      climbUuid,
      angle: 40,
      position,
    })),
  );
});

afterEach(async () => {
  await db.delete(boardseshTicks).where(eq(boardseshTicks.userId, climberId));
  await db.delete(userFavorites).where(eq(userFavorites.userId, climberId));
  await db.delete(playlists).where(inArray(playlists.uuid, [playlistUuid, emptyPlaylistUuid]));
  await db
    .delete(boardClimbs)
    .where(inArray(boardClimbs.uuid, [sharedAuthoredUuid, sharedOwnerClimbUuid, ownClimbUuid]));
  await db.delete(sprayWalls).where(inArray(sprayWalls.boardUuid, [sharedBoardUuid, ownBoardUuid]));
  if (gymId !== null) await db.delete(gyms).where(eq(gyms.id, gymId));
  await db.delete(users).where(inArray(users.id, [climberId, wallOwnerId]));
  gymId = null;
});

describe('spray visibility when generating a personal archive', () => {
  it.each(['wall becomes private', 'gym membership revoked'] as const)(
    'keeps personal records while withholding inaccessible metadata after %s',
    async (change) => {
      if (change === 'gym membership revoked') {
        await db.update(userBoards).set({ isPublic: false }).where(eq(userBoards.uuid, sharedBoardUuid));
        await db.insert(gymMembers).values({ gymId: gymId!, userId: climberId, role: 'member' });
      }
      const before = await buildUserDataArchive(db, climberId, 'spray', '2026-W40');
      expect(before.climbs.map((climb) => climb.uuid)).toEqual(
        expect.arrayContaining([sharedAuthoredUuid, ownClimbUuid]),
      );
      expect(before.ticks.find((tick) => tick.climbUuid === aliasUuid)?.climbName).toBe('Shared wall owner route');
      if (change === 'wall becomes private')
        await db.update(userBoards).set({ isPublic: false }).where(eq(userBoards.uuid, sharedBoardUuid));
      else await db.delete(gymMembers).where(and(eq(gymMembers.gymId, gymId!), eq(gymMembers.userId, climberId)));

      const after = await buildUserDataArchive(db, climberId, 'spray', '2026-W41');
      expect(after.climbs).toEqual([
        expect.objectContaining({ uuid: ownClimbUuid, name: 'Own private route', frames: 'p222r1', isDraft: true }),
      ]);
      expect(after.ticks).toHaveLength(3);
      expect(after.favorites).toHaveLength(3);
      expect(after.playlists).toHaveLength(2);
      expect(after.playlists.find((playlist) => playlist.uuid === emptyPlaylistUuid)?.climbs).toEqual([]);
      const playlistItems = after.playlists.find((playlist) => playlist.uuid === playlistUuid)!.climbs;
      expect(playlistItems.map((climb) => climb.climbUuid)).toEqual([
        aliasUuid,
        sharedAuthoredUuid,
        ownClimbUuid,
        unresolvedUuid,
      ]);
      for (const climbUuid of [aliasUuid, sharedAuthoredUuid]) {
        expect(after.ticks.find((tick) => tick.climbUuid === climbUuid)).toMatchObject({
          climbUuid,
          climbName: null,
          comment: 'Keep my personal note',
          status: 'send',
          isMirror: true,
        });
        expect(after.favorites.find((favorite) => favorite.climbUuid === climbUuid)).toMatchObject({
          climbUuid,
          climbName: null,
        });
        expect(playlistItems.find((climb) => climb.climbUuid === climbUuid)).toMatchObject({
          climbUuid,
          climbName: null,
        });
      }
      expect(after.ticks.find((tick) => tick.climbUuid === aliasUuid)?.canonicalClimbUuid).toBe(sharedOwnerClimbUuid);
      expect(after.ticks.find((tick) => tick.climbUuid === ownClimbUuid)?.climbName).toBe('Own private route');
      const serialized = JSON.stringify(after);
      expect(serialized).not.toContain('Shared wall authored route');
      expect(serialized).not.toContain('Shared wall owner route');
      expect(serialized).not.toContain('Shared wall secret description');
      expect(serialized).not.toContain('p666r3');
    },
  );
});
