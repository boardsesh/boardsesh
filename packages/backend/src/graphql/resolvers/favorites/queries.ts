import { eq, and, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../shared/helpers';
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
      .select({ climbUuid: dbSchema.userFavorites.climbUuid })
      .from(dbSchema.userFavorites)
      .where(and(eq(dbSchema.userFavorites.userId, ctx.userId), inArray(dbSchema.userFavorites.climbUuid, climbUuids)));

    return favorites.map((favorite) => favorite.climbUuid);
  },
};
