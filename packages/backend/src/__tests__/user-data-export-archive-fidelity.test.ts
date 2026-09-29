import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import { inArray, sql } from 'drizzle-orm';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import {
  boardClimbAliases,
  boardClimbs,
  boardseshTicks,
  playlistClimbs,
  playlistOwnership,
  playlists,
  sprayWalls,
  userFavorites,
  userBoards,
  users,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  buildAuroraExportFromArchive,
  buildUserDataArchive,
  MAX_USER_DATA_EXPORT_BYTES,
  MAX_USER_DATA_EXPORT_ROWS,
} from '../services/user-data-export-archive';
import { isAuroraBoardType } from '../services/user-data-export-format';

const fixturePrefix = `export-fidelity-${randomUUID()}`;
const fixtureUserId = `${fixturePrefix}-user`;
const foreignUserId = `${fixturePrefix}-foreign`;
const oversizedUserId = `${fixturePrefix}-oversized`;
const manyRowsUserId = `${fixturePrefix}-many-rows`;
const fixtureClimbUuids: string[] = [];
const fixturePlaylistIds: bigint[] = [];
const fixtureSprayBoardUuids: string[] = [];
const largeIdBase = BigInt(Date.now()) * 100000n;

describe('weekly archive fidelity for every supported board', () => {
  afterAll(async () => {
    if (fixturePlaylistIds.length) await db.delete(playlists).where(inArray(playlists.id, fixturePlaylistIds));
    if (fixtureClimbUuids.length) await db.delete(boardClimbs).where(inArray(boardClimbs.uuid, fixtureClimbUuids));
    if (fixtureSprayBoardUuids.length)
      await db.delete(sprayWalls).where(inArray(sprayWalls.boardUuid, fixtureSprayBoardUuids));
    await db.delete(users).where(inArray(users.id, [fixtureUserId, foreignUserId, oversizedUserId, manyRowsUserId]));
  });

  it.each(SUPPORTED_BOARDS)('retains identifiers, unresolved records, and drafts on %s', async (boardType) => {
    const boardIndex = SUPPORTED_BOARDS.indexOf(boardType);
    const recordId = largeIdBase + BigInt(boardIndex * 100);
    const canonicalUuid = `${fixturePrefix}-${boardType}-canonical`;
    const aliasUuid = `${fixturePrefix}-${boardType}-alias`;
    const unresolvedUuid = `${fixturePrefix}-${boardType}-missing`;
    const draftUuid = `${fixturePrefix}-${boardType}-draft`;
    const foreignUuid = `${fixturePrefix}-${boardType}-foreign`;
    const playlistId = recordId + 1n;
    const emptyPlaylistId = recordId + 2n;
    const viewerPlaylistId = recordId + 3n;
    const timestamp = new Date('2026-09-29T12:34:56Z');
    const layoutId = boardType === 'spray' ? 900001 : 1;
    const installationId = recordId + 17n;

    await db
      .insert(users)
      .values([
        { id: fixtureUserId, email: `${fixtureUserId}@example.com`, name: 'Archive climber' },
        { id: foreignUserId, email: `${foreignUserId}@example.com`, name: 'Other climber' },
      ])
      .onConflictDoNothing();
    // This schema field uses number mode; SQL preserves an intentionally unsafe integer.
    await db.insert(userBoards).values({
      id: sql`${String(installationId)}::bigint`,
      uuid: `${fixturePrefix}-${boardType}-installation`,
      slug: `${fixturePrefix}-${boardType}-installation`,
      ownerId: fixtureUserId,
      boardType,
      layoutId,
      sizeId: 1,
      setIds: '1',
      name: 'Archive fixture installation',
    });
    if (boardType === 'spray') {
      const boardUuid = `${fixturePrefix}-${boardType}-installation`;
      fixtureSprayBoardUuids.push(boardUuid);
      await db.insert(sprayWalls).values({ boardUuid, layoutId });
    }
    fixtureClimbUuids.push(canonicalUuid, draftUuid, foreignUuid);
    await db.insert(boardClimbs).values([
      { uuid: canonicalUuid, boardType, layoutId, name: 'Canonical route', createdAt: timestamp.toISOString() },
      {
        uuid: draftUuid,
        boardType,
        layoutId,
        userId: fixtureUserId,
        name: null,
        isDraft: true,
        frames: 'p900001r1,p900002r3',
        framesCount: 2,
        framesPace: 450,
        angle: 40,
        createdAt: timestamp.toISOString(),
        characteristics: ['no_match'],
      },
      { uuid: foreignUuid, boardType, layoutId, userId: foreignUserId, name: 'Private foreign draft', isDraft: true },
    ]);
    await db.insert(boardClimbAliases).values({ boardType, aliasUuid, canonicalUuid, source: 'test' });
    await db.insert(boardseshTicks).values([
      {
        id: recordId,
        uuid: `${fixturePrefix}-${boardType}-flash`,
        userId: fixtureUserId,
        boardType,
        climbUuid: aliasUuid,
        status: 'flash',
        angle: 40,
        isMirror: true,
        quality: 5,
        difficulty: 7,
        comment: 'Foot swapped',
        boardId: sql`${String(installationId)}::bigint`,
        climbedAt: timestamp.toISOString(),
      },
      {
        id: recordId + 1n,
        uuid: `${fixturePrefix}-${boardType}-attempt`,
        userId: fixtureUserId,
        boardType,
        climbUuid: unresolvedUuid,
        status: 'attempt',
        attemptCount: 4,
        angle: 35,
        comment: 'Keep this unresolved project',
        climbedAt: timestamp.toISOString(),
      },
      {
        id: recordId + 2n,
        uuid: `${fixturePrefix}-${boardType}-foreign-tick`,
        userId: foreignUserId,
        boardType,
        climbUuid: canonicalUuid,
        status: 'send',
        angle: 40,
        climbedAt: timestamp.toISOString(),
      },
    ]);
    await db.insert(userFavorites).values([
      { id: recordId, userId: fixtureUserId, boardName: boardType, climbUuid: aliasUuid, angle: 40 },
      { id: recordId + 1n, userId: fixtureUserId, boardName: boardType, climbUuid: unresolvedUuid, angle: 35 },
    ]);
    fixturePlaylistIds.push(playlistId, emptyPlaylistId, viewerPlaylistId);
    await db.insert(playlists).values([
      {
        id: playlistId,
        uuid: `${fixturePrefix}-${boardType}-playlist`,
        boardType,
        layoutId,
        name: 'Ordered crew projects',
        color: '#123456',
        isPublic: false,
      },
      { id: emptyPlaylistId, uuid: `${fixturePrefix}-${boardType}-empty`, boardType, name: 'Empty but mine' },
      { id: viewerPlaylistId, uuid: `${fixturePrefix}-${boardType}-viewer`, boardType, name: 'Viewed only' },
    ]);
    await db.insert(playlistOwnership).values([
      { playlistId, userId: fixtureUserId, role: 'owner' },
      { playlistId: emptyPlaylistId, userId: fixtureUserId, role: 'owner' },
      { playlistId: viewerPlaylistId, userId: fixtureUserId, role: 'viewer' },
    ]);
    await db.insert(playlistClimbs).values([
      { id: recordId, playlistId, climbUuid: unresolvedUuid, angle: null, position: 0 },
      { id: recordId + 1n, playlistId, climbUuid: aliasUuid, angle: 40, position: 3 },
    ]);

    const archive = await buildUserDataArchive(db, fixtureUserId, boardType, '2026-W40');

    expect(archive).toMatchObject({ schemaVersion: 1, boardType, period: '2026-W40', user: { id: fixtureUserId } });
    expect(archive.ticks).toHaveLength(2);
    expect(archive.ticks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: String(recordId),
          climbUuid: aliasUuid,
          canonicalClimbUuid: canonicalUuid,
          climbName: 'Canonical route',
          status: 'flash',
          isMirror: true,
          comment: 'Foot swapped',
          boardId: String(installationId),
          difficulty: 7,
        }),
        expect.objectContaining({
          id: String(recordId + 1n),
          climbUuid: unresolvedUuid,
          climbName: null,
          status: 'attempt',
          attemptCount: 4,
          comment: 'Keep this unresolved project',
        }),
      ]),
    );
    expect(archive.favorites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: String(recordId),
          climbUuid: aliasUuid,
          canonicalClimbUuid: canonicalUuid,
          angle: 40,
        }),
        expect.objectContaining({ climbUuid: unresolvedUuid, climbName: null, angle: 35 }),
      ]),
    );
    expect(archive.favorites).toHaveLength(2);
    expect(archive.playlists).toHaveLength(2);
    expect(archive.playlists.find((playlist) => playlist.id === String(emptyPlaylistId))?.climbs).toEqual([]);
    expect(archive.playlists.find((playlist) => playlist.id === String(playlistId))?.climbs).toEqual([
      expect.objectContaining({
        id: String(recordId),
        climbUuid: unresolvedUuid,
        climbName: null,
        angle: null,
        position: 0,
      }),
      expect.objectContaining({
        id: String(recordId + 1n),
        climbUuid: aliasUuid,
        canonicalClimbUuid: canonicalUuid,
        climbName: 'Canonical route',
        angle: 40,
        position: 3,
      }),
    ]);
    expect(archive.climbs).toEqual([
      expect.objectContaining({
        uuid: draftUuid,
        name: null,
        layoutId,
        isDraft: true,
        frames: 'p900001r1,p900002r3',
        framesCount: 2,
        framesPace: 450,
        characteristics: ['no_match'],
      }),
    ]);
    expect(() => JSON.stringify(archive)).not.toThrow();
    if (isAuroraBoardType(boardType)) {
      const companion = buildAuroraExportFromArchive(archive, boardType);
      expect(Object.keys(companion).sort()).toEqual(['ascents', 'attempts', 'circuits', 'climbs', 'likes', 'user']);
      expect(companion.ascents).toEqual([expect.objectContaining({ climb: 'Canonical route', angle: 40, stars: 5 })]);
      expect(companion.likes).toEqual([expect.objectContaining({ climb: 'Canonical route' })]);
      expect(companion.circuits).toEqual([
        expect.objectContaining({ name: 'Ordered crew projects', is_private: true, climbs: ['Canonical route'] }),
        expect.objectContaining({ name: 'Empty but mine', climbs: [] }),
      ]);
      expect(companion.climbs).toEqual([expect.objectContaining({ name: draftUuid, is_draft: true })]);
    }
  });

  it('rejects an account that no longer exists', async () => {
    await expect(buildUserDataArchive(db, `${fixturePrefix}-deleted`, 'kilter', '2026-W40')).rejects.toThrow(
      'EXPORT_USER_MISSING',
    );
  });

  it('rejects an oversized comment before loading personal rows', async () => {
    await db.insert(users).values({ id: oversizedUserId, email: `${oversizedUserId}@example.com` });
    await db.insert(boardseshTicks).values({
      uuid: `${fixturePrefix}-oversized-tick`,
      userId: oversizedUserId,
      boardType: 'kilter',
      climbUuid: `${fixturePrefix}-unresolved`,
      status: 'attempt',
      angle: 40,
      comment: sql`repeat('x', ${MAX_USER_DATA_EXPORT_BYTES + 1})`,
      climbedAt: '2026-09-29T12:34:56Z',
    });
    await expect(buildUserDataArchive(db, oversizedUserId, 'kilter', '2026-W40')).rejects.toThrow('EXPORT_TOO_LARGE');
  });

  it('rejects a history above the row budget instead of silently truncating it', async () => {
    await db.insert(users).values({ id: manyRowsUserId, email: `${manyRowsUserId}@example.com` });
    // Drizzle cannot express generate_series; one indexed fixture insert avoids
    // 20,001 network round trips and keeps this boundary test inexpensive.
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
      SELECT ${manyRowsUserId}, 'kilter', 'fixture-' || ordinal, 40
      FROM generate_series(1, ${MAX_USER_DATA_EXPORT_ROWS + 1}) AS ordinal
    `);
    await expect(buildUserDataArchive(db, manyRowsUserId, 'kilter', '2026-W40')).rejects.toThrow('EXPORT_TOO_LARGE');
  });

  it('does not query after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildUserDataArchive(db, fixtureUserId, 'kilter', '2026-W40', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
