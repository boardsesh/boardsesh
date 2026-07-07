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
        boardName: input.boardName,
        climbUuid: input.climbUuid,
        angle: input.angle,
      })
      .onConflictDoNothing({
        target: [
          dbSchema.userFavorites.userId,
          dbSchema.userFavorites.boardName,
          dbSchema.userFavorites.climbUuid,
          dbSchema.userFavorites.angle,
        ],
      })
      .returning({ id: dbSchema.userFavorites.id });

    if (inserted.length > 0) {
      return { favorited: true };
    }

    await db
      .delete(dbSchema.userFavorites)
      .where(
        and(
          eq(dbSchema.userFavorites.userId, userId),
          eq(dbSchema.userFavorites.boardName, input.boardName),
          eq(dbSchema.userFavorites.climbUuid, input.climbUuid),
          eq(dbSchema.userFavorites.angle, input.angle),
        ),
      );
    return { favorited: false };
  },

  /**
   * Add a climb to favorites. Idempotent: ON CONFLICT (user_id, board_name,
   * climb_uuid, angle) DO NOTHING. Safe for the mobile offline mutation queue to
   * replay — a second add for the same (user, board, climb, angle) is a no-op,
   * never a duplicate row. Always returns true.
   */
  addFavorite: async (_: unknown, { input }: { input: AddFavoriteInput }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(AddFavoriteInputSchema, input, 'input');

    const userId = ctx.userId!;

    await db
      .insert(dbSchema.userFavorites)
      .values({
        userId,
        boardName: input.boardName,
        climbUuid: input.climbUuid,
        angle: input.angle,
      })
      .onConflictDoNothing({
        target: [
          dbSchema.userFavorites.userId,
          dbSchema.userFavorites.boardName,
          dbSchema.userFavorites.climbUuid,
          dbSchema.userFavorites.angle,
        ],
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
      .where(
        and(
          eq(dbSchema.userFavorites.userId, userId),
          eq(dbSchema.userFavorites.boardName, input.boardName),
          eq(dbSchema.userFavorites.climbUuid, input.climbUuid),
          eq(dbSchema.userFavorites.angle, input.angle),
        ),
      );

    return true;
  },
};
