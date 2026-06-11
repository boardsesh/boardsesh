import { eq, and, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../shared/helpers';
import { FavoritesQueryClimbUuidsSchema } from '../../../validation/schemas';

export const favoriteQueries = {
  favorites: async (
    _: unknown,
    { climbUuids }: { climbUuids: string[] },
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

    return favorites.map((f) => f.climbUuid);
  },
};
