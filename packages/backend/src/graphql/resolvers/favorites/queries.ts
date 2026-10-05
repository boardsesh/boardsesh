import { eq, and, inArray, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { FavoritesQueryClimbUuidsSchema } from '../../../validation/schemas';

export const favoriteQueries = {
  /**
   * Get favorite climb UUIDs for the authenticated user.
   *
   * Favorites are keyed by (user_id, climb_uuid), so the answer is the same
   * whichever board or angle the caller is looking at. `boardName` and `angle`
   * are still accepted (older binaries pass them) and ignored.
   */
  favorites: async (
    _: unknown,
    { climbUuids }: { boardName?: string | null; climbUuids: string[]; angle?: number | null },
    ctx: ConnectionContext,
  ): Promise<string[]> => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      return [];
    }

    validateInput(FavoritesQueryClimbUuidsSchema, climbUuids, 'climbUuids');

    const favorites = await db
      .selectDistinct({ climbUuid: dbSchema.userFavorites.climbUuid })
      .from(dbSchema.userFavorites)
      .where(and(eq(dbSchema.userFavorites.userId, ctx.userId), inArray(dbSchema.userFavorites.climbUuid, climbUuids)));

    return favorites.map((favorite) => favorite.climbUuid);
  },

  /**
   * Retained for shipped clients. Resolve board identity from the catalog,
   * matching the favorite-climb list after the UUID rekey.
   */
  userFavoritesCounts: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext,
  ): Promise<Array<{ boardName: string; count: number }>> => {
    requireAuthenticated(ctx);

    const results = await db
      .select({
        boardName: dbSchema.boardClimbs.boardType,
        count: sql<number>`COUNT(DISTINCT ${dbSchema.userFavorites.climbUuid})::int`,
      })
      .from(dbSchema.userFavorites)
      .innerJoin(dbSchema.boardClimbs, eq(dbSchema.boardClimbs.uuid, dbSchema.userFavorites.climbUuid))
      .where(eq(dbSchema.userFavorites.userId, ctx.userId!))
      .groupBy(dbSchema.boardClimbs.boardType);

    return results;
  },

  /**
   * Retained for shipped clients: boards with playlists or catalog favorites.
   */
  userActiveBoards: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<string[]> => {
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Get distinct board names from playlists
    const playlistBoards = await db
      .selectDistinct({ boardName: dbSchema.playlists.boardType })
      .from(dbSchema.playlists)
      .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
      .where(eq(dbSchema.playlistOwnership.userId, userId));

    // Get distinct board names from favorites
    const favoriteBoards = await db
      .selectDistinct({ boardName: dbSchema.boardClimbs.boardType })
      .from(dbSchema.userFavorites)
      .innerJoin(dbSchema.boardClimbs, eq(dbSchema.boardClimbs.uuid, dbSchema.userFavorites.climbUuid))
      .where(eq(dbSchema.userFavorites.userId, userId));

    // Combine and deduplicate
    const boardSet = new Set<string>();
    for (const row of playlistBoards) {
      boardSet.add(row.boardName);
    }
    for (const row of favoriteBoards) {
      boardSet.add(row.boardName);
    }

    return Array.from(boardSet).sort();
  },
};
