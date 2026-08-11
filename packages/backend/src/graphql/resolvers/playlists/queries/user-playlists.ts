import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../../shared/helpers';
import { GetUserPlaylistsInputSchema, GetAllUserPlaylistsInputSchema } from '../../../../validation/schemas';
import { getPlaylistFollowStats } from '../helpers/follow-stats';
import { getClimbCounts, formatOwnedPlaylist, type OwnedPlaylistRow } from '../helpers/enrichment';

/**
 * Build the select shape for owned-playlist queries. isPinnedByMe is computed
 * by the caller's user-scoped LEFT JOIN against userPlaylistPins — same query,
 * no extra round-trip.
 */
function ownedPlaylistSelect() {
  return {
    id: dbSchema.playlists.id,
    uuid: dbSchema.playlists.uuid,
    boardType: dbSchema.playlists.boardType,
    layoutId: dbSchema.playlists.layoutId,
    name: dbSchema.playlists.name,
    description: dbSchema.playlists.description,
    isPublic: dbSchema.playlists.isPublic,
    color: dbSchema.playlists.color,
    icon: dbSchema.playlists.icon,
    createdAt: dbSchema.playlists.createdAt,
    updatedAt: dbSchema.playlists.updatedAt,
    lastAccessedAt: dbSchema.playlists.lastAccessedAt,
    role: dbSchema.playlistOwnership.role,
    isPinnedByMe: sql<boolean>`${dbSchema.userPlaylistPins.id} IS NOT NULL`,
  } as const;
}

const PLAYLIST_ORDER = desc(sql`COALESCE(${dbSchema.playlists.lastAccessedAt}, ${dbSchema.playlists.updatedAt})`);

/**
 * Enrich owned playlist rows with climb counts and follow stats.
 * isPinnedByMe is already on the row from the LEFT JOIN.
 */
async function enrichOwnedPlaylists(playlists: OwnedPlaylistRow[], userId: string) {
  const [countMap, followStats] = await Promise.all([
    getClimbCounts(playlists.map((p) => p.id)),
    getPlaylistFollowStats(
      playlists.map((p) => p.uuid),
      userId,
    ),
  ]);
  return playlists.map((p) => formatOwnedPlaylist(p, countMap, followStats));
}

/**
 * Get all playlists owned by the authenticated user for a specific board and layout
 */
export const userPlaylists = async (
  _: unknown,
  { input }: { input: { boardType: string; layoutId: number } },
  ctx: ConnectionContext,
): Promise<unknown[]> => {
  requireAuthenticated(ctx);
  validateInput(GetUserPlaylistsInputSchema, input, 'input');

  const userId = ctx.userId!;

  const userPlaylists = await db
    .select(ownedPlaylistSelect())
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .leftJoin(
      dbSchema.userPlaylistPins,
      and(
        eq(dbSchema.userPlaylistPins.playlistId, dbSchema.playlists.id),
        eq(dbSchema.userPlaylistPins.userId, userId),
      ),
    )
    .where(
      and(
        eq(dbSchema.playlistOwnership.userId, userId),
        eq(dbSchema.playlistOwnership.role, 'owner'),
        eq(dbSchema.playlists.boardType, input.boardType),
        or(eq(dbSchema.playlists.layoutId, input.layoutId), isNull(dbSchema.playlists.layoutId)),
      ),
    )
    .orderBy(PLAYLIST_ORDER, desc(dbSchema.playlists.id));

  return enrichOwnedPlaylists(userPlaylists, userId);
};

/**
 * Get all playlists owned by the authenticated user, optionally filtered by board type
 * and layout, paginated with offset-based pagination. Mirrors discoverPlaylists' shape.
 */
export const allUserPlaylists = async (
  _: unknown,
  {
    input,
  }: {
    input: { boardType?: string; layoutId?: number; page?: number; pageSize?: number };
  },
  ctx: ConnectionContext,
): Promise<{ playlists: unknown[]; totalCount: number; hasMore: boolean }> => {
  requireAuthenticated(ctx);
  validateInput(GetAllUserPlaylistsInputSchema, input, 'input');

  const userId = ctx.userId!;
  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 20;

  const conditions = [eq(dbSchema.playlistOwnership.userId, userId), eq(dbSchema.playlistOwnership.role, 'owner')];

  if (input.boardType) {
    conditions.push(eq(dbSchema.playlists.boardType, input.boardType));
  }

  if (input.layoutId != null) {
    const layoutCondition = or(eq(dbSchema.playlists.layoutId, input.layoutId), isNull(dbSchema.playlists.layoutId));
    if (layoutCondition) {
      conditions.push(layoutCondition);
    }
  }

  const whereClause = and(...conditions);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .where(whereClause);
  const totalCount = countResult[0]?.count ?? 0;

  const rows = await db
    .select(ownedPlaylistSelect())
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .leftJoin(
      dbSchema.userPlaylistPins,
      and(
        eq(dbSchema.userPlaylistPins.playlistId, dbSchema.playlists.id),
        eq(dbSchema.userPlaylistPins.userId, userId),
      ),
    )
    .where(whereClause)
    .orderBy(PLAYLIST_ORDER, desc(dbSchema.playlists.id))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const hasMore = rows.length > pageSize;
  const trimmed = hasMore ? rows.slice(0, pageSize) : rows;

  return {
    playlists: await enrichOwnedPlaylists(trimmed, userId),
    totalCount,
    hasMore,
  };
};
