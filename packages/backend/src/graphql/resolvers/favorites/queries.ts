import { eq, and, inArray, sql } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../db/client';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema, FavoritesQueryClimbUuidsSchema } from '../../../validation/schemas';

export const favoriteQueries = {
  /**
   * Get favorite climb UUIDs for the authenticated user
   * Filters by board name, angle, and optionally by a list of climb UUIDs
   */
  favorites: async (
    _: unknown,
    { boardName, climbUuids, angle }: { boardName: string; climbUuids: string[]; angle: number },
    ctx: ConnectionContext
  ): Promise<string[]> => {
    const db = ctx.db as RequestDbInstance;
    if (!ctx.isAuthenticated || !ctx.userId) {
      return [];
    }

    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(FavoritesQueryClimbUuidsSchema, climbUuids, 'climbUuids');

    const favorites = await db
      .select({ climbUuid: dbSchema.userFavorites.climbUuid })
      .from(dbSchema.userFavorites)
      .where(
        and(
          eq(dbSchema.userFavorites.userId, ctx.userId),
          eq(dbSchema.userFavorites.boardName, boardName),
          eq(dbSchema.userFavorites.angle, angle),
          inArray(dbSchema.userFavorites.climbUuid, climbUuids)
        )
      );

    return favorites.map(f => f.climbUuid);
  },

  /**
   * Get count of favorited climbs per board for the current user
   */
  userFavoritesCounts: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext
  ): Promise<Array<{ boardName: string; count: number }>> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);

    const results = await db
      .select({
        boardName: dbSchema.userFavorites.boardName,
        count: sql<number>`COUNT(DISTINCT ${dbSchema.userFavorites.climbUuid})::int`,
      })
      .from(dbSchema.userFavorites)
      .where(eq(dbSchema.userFavorites.userId, ctx.userId!))
      .groupBy(dbSchema.userFavorites.boardName);

    return results;
  },

  /**
   * Get board names where the current user has playlists or favorites
   */
  userActiveBoards: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext
  ): Promise<string[]> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Get distinct board names from playlists
    const playlistBoards = await db
      .selectDistinct({ boardName: dbSchema.playlists.boardType })
      .from(dbSchema.playlists)
      .innerJoin(
        dbSchema.playlistOwnership,
        eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id)
      )
      .where(eq(dbSchema.playlistOwnership.userId, userId));

    // Get distinct board names from favorites
    const favoriteBoards = await db
      .selectDistinct({ boardName: dbSchema.userFavorites.boardName })
      .from(dbSchema.userFavorites)
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
