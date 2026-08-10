import { eq, and } from 'drizzle-orm';
import type {
  ConnectionContext,
  ToggleFavoriteInput,
  ToggleFavoriteResult,
  AddFavoriteInput,
  RemoveFavoriteInput,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import {
  ToggleFavoriteInputSchema,
  AddFavoriteInputSchema,
  RemoveFavoriteInputSchema,
} from '../../../validation/schemas';

// `boardName` and `angle` still arrive on the inputs from binaries that shipped
// before favorites were re-keyed. They are accepted and ignored — a favorite is
// keyed by (user_id, climb_uuid) alone. The fields come off the schema entirely
// once the store fleet has rolled past this release.

export const favoriteMutations = {
  /**
   * Toggle favorite status for a climb
   * If favorited, removes the favorite; if not favorited, adds it.
   * The insert-first upsert keeps concurrent toggles race-free: exactly one of
   * two racing calls wins the INSERT (unique_user_favorite), the other falls
   * through to the DELETE branch instead of hitting a unique violation.
   */
  toggleFavorite: async (
    _: unknown,
    { input }: { input: ToggleFavoriteInput },
    ctx: ConnectionContext,
  ): Promise<ToggleFavoriteResult> => {
    requireAuthenticated(ctx);
    validateInput(ToggleFavoriteInputSchema, input, 'input');

    const userId = ctx.userId!;

    const inserted = await db
      .insert(dbSchema.userFavorites)
      .values({
        userId,
        climbUuid: input.climbUuid,
      })
      .onConflictDoNothing({
        target: [dbSchema.userFavorites.userId, dbSchema.userFavorites.climbUuid],
      })
      .returning({ id: dbSchema.userFavorites.id });

    if (inserted.length > 0) {
      return { favorited: true };
    }

    await db
      .delete(dbSchema.userFavorites)
      .where(and(eq(dbSchema.userFavorites.userId, userId), eq(dbSchema.userFavorites.climbUuid, input.climbUuid)));
    return { favorited: false };
  },

  /**
   * Add a climb to favorites. Idempotent: ON CONFLICT (user_id, climb_uuid) DO
   * NOTHING. Safe for the mobile offline mutation queue to replay — a second add
   * for the same (user, climb) is a no-op, never a duplicate row. Always returns
   * true.
   */
  addFavorite: async (_: unknown, { input }: { input: AddFavoriteInput }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(AddFavoriteInputSchema, input, 'input');

    const userId = ctx.userId!;

    await db
      .insert(dbSchema.userFavorites)
      .values({
        userId,
        climbUuid: input.climbUuid,
      })
      .onConflictDoNothing({
        target: [dbSchema.userFavorites.userId, dbSchema.userFavorites.climbUuid],
      });

    return true;
  },

  /**
   * Remove a climb from favorites. Idempotent: deleting a row that doesn't exist
   * is a no-op, so the offline mutation queue can replay an unfavorite safely
   * without inverting state (unlike toggleFavorite). Always returns true.
   */
  removeFavorite: async (
    _: unknown,
    { input }: { input: RemoveFavoriteInput },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(RemoveFavoriteInputSchema, input, 'input');

    const userId = ctx.userId!;

    await db
      .delete(dbSchema.userFavorites)
      .where(and(eq(dbSchema.userFavorites.userId, userId), eq(dbSchema.userFavorites.climbUuid, input.climbUuid)));

    return true;
  },
};
