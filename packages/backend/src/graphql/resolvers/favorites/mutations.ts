import { eq, and } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../db/client';import type { ConnectionContext, ToggleFavoriteInput, ToggleFavoriteResult } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { ToggleFavoriteInputSchema } from '../../../validation/schemas';

export const favoriteMutations = {
  /**
   * Toggle favorite status for a climb
   * If favorited, removes the favorite; if not favorited, adds it
   */
  toggleFavorite: async (
    _: unknown,
    { input }: { input: ToggleFavoriteInput },
    ctx: ConnectionContext
  ): Promise<ToggleFavoriteResult> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    validateInput(ToggleFavoriteInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check if favorite exists
    const existing = await db
      .select()
      .from(dbSchema.userFavorites)
      .where(
        and(
          eq(dbSchema.userFavorites.userId, userId),
          eq(dbSchema.userFavorites.boardName, input.boardName),
          eq(dbSchema.userFavorites.climbUuid, input.climbUuid),
          eq(dbSchema.userFavorites.angle, input.angle)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Remove favorite
      await db
        .delete(dbSchema.userFavorites)
        .where(
          and(
            eq(dbSchema.userFavorites.userId, userId),
            eq(dbSchema.userFavorites.boardName, input.boardName),
            eq(dbSchema.userFavorites.climbUuid, input.climbUuid),
            eq(dbSchema.userFavorites.angle, input.angle)
          )
        );
      return { favorited: false };
    } else {
      // Add favorite
      await db.insert(dbSchema.userFavorites).values({
        userId,
        boardName: input.boardName,
        climbUuid: input.climbUuid,
        angle: input.angle,
      });
      return { favorited: true };
    }
  },
};
