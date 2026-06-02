import { eq, and } from 'drizzle-orm';
import type { ConnectionContext, ToggleFavoriteInput, ToggleFavoriteResult } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { ToggleFavoriteInputSchema } from '../../../validation/schemas';

export const favoriteMutations = {
  toggleFavorite: async (
    _: unknown,
    { input }: { input: ToggleFavoriteInput },
    ctx: ConnectionContext,
  ): Promise<ToggleFavoriteResult> => {
    requireAuthenticated(ctx);
    validateInput(ToggleFavoriteInputSchema, input, 'input');

    const userId = ctx.userId!;
    const where = and(eq(dbSchema.userFavorites.userId, userId), eq(dbSchema.userFavorites.climbUuid, input.climbUuid));

    const existing = await db.select().from(dbSchema.userFavorites).where(where).limit(1);

    if (existing.length > 0) {
      await db.delete(dbSchema.userFavorites).where(where);
      return { favorited: false };
    }

    await db.insert(dbSchema.userFavorites).values({
      userId,
      climbUuid: input.climbUuid,
    });
    return { favorited: true };
  },
};
