import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

/** Raw playlist row shape from owned-playlist queries (userPlaylists, allUserPlaylists).
 *  isPinnedByMe is computed inline via a LEFT JOIN on userPlaylistPins so the
 *  flag is available on the row without a second round-trip. */
export type OwnedPlaylistRow = {
  id: bigint;
  uuid: string;
  boardType: string;
  layoutId: number | null;
  name: string;
  description: string | null;
  isPublic: boolean;
  color: string | null;
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
  role: string;
  isPinnedByMe: boolean;
};

/** Fetch climb counts for a list of playlist numeric IDs. Returns Map<stringId, count>. */
export async function getClimbCounts(playlistIds: bigint[]): Promise<Map<string, number>> {
  if (playlistIds.length === 0) return new Map();

  const climbCounts = await db
    .select({
      playlistId: dbSchema.playlistClimbs.playlistId,
      count: sql<number>`count(*)::int`,
    })
    .from(dbSchema.playlistClimbs)
    .where(inArray(dbSchema.playlistClimbs.playlistId, playlistIds))
    .groupBy(dbSchema.playlistClimbs.playlistId);

  return new Map(climbCounts.map((c) => [c.playlistId.toString(), c.count]));
}

/** Transform an owned playlist DB row into the GraphQL response shape.
 *  isPinnedByMe rides on the row from the LEFT JOIN — no separate lookup. */
export function formatOwnedPlaylist(
  p: OwnedPlaylistRow,
  climbCountMap: Map<string, number>,
  followStats: Map<string, { followerCount: number; isFollowedByMe: boolean }>,
) {
  const stats = followStats.get(p.uuid) ?? { followerCount: 0, isFollowedByMe: false };
  return {
    id: p.id.toString(),
    uuid: p.uuid,
    boardType: p.boardType,
    layoutId: p.layoutId,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    color: p.color,
    icon: p.icon,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    lastAccessedAt: p.lastAccessedAt?.toISOString() ?? null,
    climbCount: climbCountMap.get(p.id.toString()) || 0,
    userRole: p.role,
    followerCount: stats.followerCount,
    isFollowedByMe: stats.isFollowedByMe,
    isPinnedByMe: p.isPinnedByMe,
  };
}

/** Raw row shape from discover / search playlist queries. */
export type PublicPlaylistRow = {
  id: bigint;
  uuid: string;
  boardType: string;
  layoutId: number | null;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  createdAt: Date;
  updatedAt: Date;
  creatorId: string;
  creatorName: string;
  climbCount: number;
  generatedRecommendation: string | null;
};

/** Transform a public playlist DB row into the GraphQL response shape. */
export function formatPublicPlaylist(p: PublicPlaylistRow) {
  return {
    id: p.id.toString(),
    uuid: p.uuid,
    boardType: p.boardType,
    layoutId: p.layoutId,
    name: p.name,
    description: p.description,
    color: p.color,
    icon: p.icon,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    climbCount: p.climbCount,
    creatorId: p.creatorId,
    creatorName: p.creatorName,
    isGeneratedRecommendation: p.generatedRecommendation !== null,
  };
}

/**
 * Check if a user has access to a playlist. Returns the numeric playlist ID.
 * Throws if playlist not found or user lacks access to a private playlist.
 */
export async function verifyPlaylistAccess(playlistUuid: string, userId: string | null): Promise<bigint> {
  const playlistResult = await db
    .select({
      id: dbSchema.playlists.id,
      isPublic: dbSchema.playlists.isPublic,
    })
    .from(dbSchema.playlists)
    .where(eq(dbSchema.playlists.uuid, playlistUuid))
    .limit(1);

  if (playlistResult.length === 0) {
    throw new Error('Playlist not found or access denied');
  }

  if (!playlistResult[0].isPublic) {
    if (!userId) {
      throw new Error('Playlist not found or access denied');
    }

    const ownershipResult = await db
      .select({ role: dbSchema.playlistOwnership.role })
      .from(dbSchema.playlistOwnership)
      .where(
        and(
          eq(dbSchema.playlistOwnership.playlistId, playlistResult[0].id),
          eq(dbSchema.playlistOwnership.userId, userId),
        ),
      )
      .limit(1);

    if (ownershipResult.length === 0) {
      throw new Error('Playlist not found or access denied');
    }
  }

  return playlistResult[0].id;
}
