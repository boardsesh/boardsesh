import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import {
  boardClimbAliases,
  boardClimbs,
  boardDifficultyGrades,
  boardseshTicks,
  playlistClimbs,
  playlistOwnership,
  playlists,
  userFavorites,
  users,
} from '@boardsesh/db/schema';
import type { AuroraBoardName, BoardName } from '@boardsesh/shared-schema';
import { buildAuroraJsonExport, type ExportCircuitRow } from './user-data-export-format';

export type ArchiveTick = {
  id: string;
  uuid: string;
  climbUuid: string;
  canonicalClimbUuid: string | null;
  climbName: string | null;
  status: 'flash' | 'send' | 'attempt';
  angle: number;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  difficultyName: string | null;
  comment: string | null;
  isMirror: boolean | null;
  isBenchmark: boolean | null;
  boardId: string | null;
  sessionId: string | null;
  origin: string;
  climbedAt: string;
  createdAt: string;
  updatedAt: string;
};
export type ArchiveFavorite = {
  id: string;
  climbUuid: string;
  canonicalClimbUuid: string | null;
  climbName: string | null;
  angle: number;
  createdAt: string;
  updatedAt: string;
};
export type ArchivePlaylistClimb = {
  id: string;
  climbUuid: string;
  canonicalClimbUuid: string | null;
  climbName: string | null;
  angle: number | null;
  position: number;
  addedAt: string;
  updatedAt: string;
};
export type ArchivePlaylist = {
  id: string;
  uuid: string;
  layoutId: number | null;
  name: string;
  color: string | null;
  icon: string | null;
  description: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  climbs: ArchivePlaylistClimb[];
};
export type ArchiveClimb = {
  uuid: string;
  name: string | null;
  layoutId: number;
  frames: string | null;
  framesCount: number | null;
  framesPace: number | null;
  angle: number | null;
  createdAt: string | null;
  updatedAt: string;
  isDraft: boolean | null;
  isListed: boolean | null;
  description: string | null;
  characteristics: string[] | null;
};

/** Personal climbing records, not a catalogue or an authentication backup. */
export type BoardseshUserDataArchive = {
  schemaVersion: 1;
  boardType: BoardName;
  period: string;
  exportedAt: string;
  user: { id: string; name: string | null; email: string | null; createdAt: string };
  ticks: ArchiveTick[];
  favorites: ArchiveFavorite[];
  playlists: ArchivePlaylist[];
  climbs: ArchiveClimb[];
};

const timestamp = (date: Date | string): string => (typeof date === 'string' ? date : date.toISOString());

/** One read of each personal collection serves both download formats. */
export async function buildUserDataArchive(
  database: DbInstance,
  userId: string,
  boardType: BoardName,
  period: string,
  signal?: AbortSignal,
): Promise<BoardseshUserDataArchive> {
  signal?.throwIfAborted();
  const [user] = await database
    .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error('EXPORT_USER_MISSING');
  const ticks = await database
    .select({
      id: boardseshTicks.id,
      uuid: boardseshTicks.uuid,
      climbUuid: boardseshTicks.climbUuid,
      canonicalClimbUuid: boardClimbAliases.canonicalUuid,
      climbName: boardClimbs.name,
      status: boardseshTicks.status,
      angle: boardseshTicks.angle,
      attemptCount: boardseshTicks.attemptCount,
      quality: boardseshTicks.quality,
      difficulty: boardseshTicks.difficulty,
      difficultyName: boardDifficultyGrades.boulderName,
      comment: boardseshTicks.comment,
      isMirror: boardseshTicks.isMirror,
      isBenchmark: boardseshTicks.isBenchmark,
      // The schema's number decoder would round IDs larger than 2^53.
      boardId: sql<string | null>`${boardseshTicks.boardId}::text`,
      sessionId: boardseshTicks.sessionId,
      origin: boardseshTicks.origin,
      climbedAt: boardseshTicks.climbedAt,
      createdAt: boardseshTicks.createdAt,
      updatedAt: boardseshTicks.updatedAt,
    })
    .from(boardseshTicks)
    .leftJoin(
      boardClimbAliases,
      and(
        eq(boardseshTicks.climbUuid, boardClimbAliases.aliasUuid),
        eq(boardseshTicks.boardType, boardClimbAliases.boardType),
      ),
    )
    .leftJoin(
      boardClimbs,
      and(
        eq(boardseshTicks.boardType, boardClimbs.boardType),
        sql`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid}) = ${boardClimbs.uuid}`,
      ),
    )
    .leftJoin(
      boardDifficultyGrades,
      and(
        eq(boardseshTicks.boardType, boardDifficultyGrades.boardType),
        eq(boardseshTicks.difficulty, boardDifficultyGrades.difficulty),
      ),
    )
    .where(and(eq(boardseshTicks.userId, userId), eq(boardseshTicks.boardType, boardType)))
    .orderBy(asc(boardseshTicks.climbedAt), asc(boardseshTicks.createdAt), asc(boardseshTicks.uuid));
  signal?.throwIfAborted();
  const favorites = await database
    .select({
      id: userFavorites.id,
      climbUuid: userFavorites.climbUuid,
      canonicalClimbUuid: boardClimbAliases.canonicalUuid,
      climbName: boardClimbs.name,
      angle: userFavorites.angle,
      createdAt: userFavorites.createdAt,
      updatedAt: userFavorites.updatedAt,
    })
    .from(userFavorites)
    .leftJoin(
      boardClimbAliases,
      and(
        eq(userFavorites.climbUuid, boardClimbAliases.aliasUuid),
        eq(userFavorites.boardName, boardClimbAliases.boardType),
      ),
    )
    .leftJoin(
      boardClimbs,
      and(
        eq(userFavorites.boardName, boardClimbs.boardType),
        sql`COALESCE(${boardClimbAliases.canonicalUuid}, ${userFavorites.climbUuid}) = ${boardClimbs.uuid}`,
      ),
    )
    .where(and(eq(userFavorites.userId, userId), eq(userFavorites.boardName, boardType)))
    .orderBy(asc(userFavorites.createdAt), asc(userFavorites.id));
  signal?.throwIfAborted();
  const playlistRows = await database
    .select({
      playlistId: playlists.id,
      uuid: playlists.uuid,
      layoutId: playlists.layoutId,
      name: playlists.name,
      color: playlists.color,
      icon: playlists.icon,
      description: playlists.description,
      isPublic: playlists.isPublic,
      createdAt: playlists.createdAt,
      updatedAt: playlists.updatedAt,
      itemId: playlistClimbs.id,
      climbUuid: playlistClimbs.climbUuid,
      canonicalClimbUuid: boardClimbAliases.canonicalUuid,
      climbName: boardClimbs.name,
      angle: playlistClimbs.angle,
      position: playlistClimbs.position,
      addedAt: playlistClimbs.addedAt,
      itemUpdatedAt: playlistClimbs.updatedAt,
    })
    .from(playlists)
    .innerJoin(
      playlistOwnership,
      and(eq(playlistOwnership.playlistId, playlists.id), eq(playlistOwnership.userId, userId)),
    )
    .leftJoin(playlistClimbs, eq(playlistClimbs.playlistId, playlists.id))
    .leftJoin(
      boardClimbAliases,
      and(
        eq(playlistClimbs.climbUuid, boardClimbAliases.aliasUuid),
        eq(playlists.boardType, boardClimbAliases.boardType),
      ),
    )
    .leftJoin(
      boardClimbs,
      and(
        eq(playlists.boardType, boardClimbs.boardType),
        sql`COALESCE(${boardClimbAliases.canonicalUuid}, ${playlistClimbs.climbUuid}) = ${boardClimbs.uuid}`,
      ),
    )
    .where(and(eq(playlists.boardType, boardType), eq(playlistOwnership.role, 'owner')))
    .orderBy(asc(playlists.createdAt), asc(playlists.id), asc(playlistClimbs.position), asc(playlistClimbs.id));
  signal?.throwIfAborted();
  const climbs = await database
    .select({
      uuid: boardClimbs.uuid,
      name: boardClimbs.name,
      layoutId: boardClimbs.layoutId,
      frames: boardClimbs.frames,
      framesCount: boardClimbs.framesCount,
      framesPace: boardClimbs.framesPace,
      angle: boardClimbs.angle,
      createdAt: boardClimbs.createdAt,
      updatedAt: boardClimbs.updatedAt,
      isDraft: boardClimbs.isDraft,
      isListed: boardClimbs.isListed,
      description: boardClimbs.description,
      characteristics: boardClimbs.characteristics,
    })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.userId, userId), eq(boardClimbs.boardType, boardType)))
    .orderBy(asc(boardClimbs.createdAt), asc(boardClimbs.uuid));
  signal?.throwIfAborted();
  const archivedPlaylists = new Map<string, ArchivePlaylist>();
  for (const row of playlistRows) {
    const playlistId = String(row.playlistId);
    let playlist = archivedPlaylists.get(playlistId);
    if (!playlist) {
      playlist = {
        id: playlistId,
        uuid: row.uuid,
        layoutId: row.layoutId,
        name: row.name,
        color: row.color,
        icon: row.icon,
        description: row.description,
        isPublic: row.isPublic,
        createdAt: timestamp(row.createdAt),
        updatedAt: timestamp(row.updatedAt),
        climbs: [],
      };
      archivedPlaylists.set(playlistId, playlist);
    }
    if (row.itemId !== null && row.climbUuid !== null && row.position !== null && row.addedAt && row.itemUpdatedAt) {
      playlist.climbs.push({
        id: String(row.itemId),
        climbUuid: row.climbUuid,
        canonicalClimbUuid: row.canonicalClimbUuid,
        climbName: row.climbName,
        angle: row.angle,
        position: row.position,
        addedAt: timestamp(row.addedAt),
        updatedAt: timestamp(row.itemUpdatedAt),
      });
    }
  }
  return {
    schemaVersion: 1,
    boardType,
    period,
    exportedAt: new Date().toISOString(),
    user: { ...user, createdAt: timestamp(user.createdAt) },
    ticks: ticks.map((tick) => ({
      ...tick,
      id: String(tick.id),
      boardId: tick.boardId === null ? null : String(tick.boardId),
    })),
    favorites: favorites.map((favorite) => ({
      ...favorite,
      id: String(favorite.id),
      createdAt: timestamp(favorite.createdAt),
      updatedAt: timestamp(favorite.updatedAt),
    })),
    playlists: [...archivedPlaylists.values()],
    climbs: climbs.map((climb) => ({ ...climb, updatedAt: timestamp(climb.updatedAt) })),
  };
}

export function buildAuroraExportFromArchive(archive: BoardseshUserDataArchive, boardType: AuroraBoardName) {
  return buildAuroraJsonExport({
    boardType,
    user: archive.user,
    ticks: archive.ticks,
    favorites: archive.favorites,
    circuitRows: archive.playlists.flatMap((playlist): ExportCircuitRow[] => {
      const circuit = {
        playlistId: playlist.id,
        name: playlist.name,
        color: playlist.color,
        createdAt: playlist.createdAt,
        description: playlist.description,
        isPublic: playlist.isPublic,
      };
      return playlist.climbs.length
        ? playlist.climbs.map((climb) => ({ ...circuit, climbName: climb.climbName, position: climb.position }))
        : [{ ...circuit, climbName: null, position: null }];
    }),
    climbs: archive.climbs,
  });
}
