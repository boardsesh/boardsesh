import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../../db/client';import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../../shared/helpers';
import {
  GetUserPlaylistsInputSchema,
  GetAllUserPlaylistsInputSchema,
} from '../../../../validation/schemas';
import { getPlaylistFollowStats } from '../helpers/follow-stats';
import { getClimbCounts, formatOwnedPlaylist, type OwnedPlaylistRow } from '../helpers/enrichment';

const PLAYLIST_SELECT = {
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
} as const;

const PLAYLIST_ORDER = desc(
  sql`COALESCE(${dbSchema.playlists.lastAccessedAt}, ${dbSchema.playlists.updatedAt})`,
);

/**
 * Enrich owned playlist rows with climb counts and follow stats.
 */
async function enrichOwnedPlaylists(playlists: OwnedPlaylistRow[], userId: string) {
  const countMap = await getClimbCounts(playlists.map(p => p.id));
  const followStats = await getPlaylistFollowStats(
    playlists.map(p => p.uuid),
    userId,
  );
  return playlists.map(p => formatOwnedPlaylist(p, countMap, followStats));
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
    .select(PLAYLIST_SELECT)
    .from(dbSchema.playlists)
    .innerJoin(
      dbSchema.playlistOwnership,
      eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id),
    )
    .where(
      and(
        eq(dbSchema.playlistOwnership.userId, userId),
        eq(dbSchema.playlists.boardType, input.boardType),
        or(
          eq(dbSchema.playlists.layoutId, input.layoutId),
          isNull(dbSchema.playlists.layoutId),
        ),
      ),
    )
    .orderBy(PLAYLIST_ORDER);

  return enrichOwnedPlaylists(userPlaylists, userId);
};

/**
 * Get all playlists owned by the authenticated user, optionally filtered by board type.
 * No layoutId filter required — shows playlists across all layouts.
 */
export const allUserPlaylists = async (
  _: unknown,
  { input }: { input: { boardType?: string; layoutId?: number } },
  ctx: ConnectionContext,
): Promise<unknown[]> => {
  requireAuthenticated(ctx);
  validateInput(GetAllUserPlaylistsInputSchema, input, 'input');

  const userId = ctx.userId!;

  const conditions = [eq(dbSchema.playlistOwnership.userId, userId)];

  if (input.boardType) {
    conditions.push(eq(dbSchema.playlists.boardType, input.boardType));
  }

  if (input.layoutId != null) {
    const layoutCondition = or(
      eq(dbSchema.playlists.layoutId, input.layoutId),
      isNull(dbSchema.playlists.layoutId),
    );
    if (layoutCondition) {
      conditions.push(layoutCondition);
    }
  }

  const playlists = await db
    .select(PLAYLIST_SELECT)
    .from(dbSchema.playlists)
    .innerJoin(
      dbSchema.playlistOwnership,
      eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id),
    )
    .where(and(...conditions))
    .orderBy(PLAYLIST_ORDER);

  return enrichOwnedPlaylists(playlists, userId);
};
