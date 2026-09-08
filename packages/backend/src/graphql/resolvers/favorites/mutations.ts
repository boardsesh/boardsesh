import { eq, and, sql } from 'drizzle-orm';
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

// Separate advisory-lock namespace ("FAVS"). The transaction lock serializes
// one user's writes to one climb across backend instances, even before the
// database has a unique (user_id, climb_uuid) index. Hash collisions only
// serialize unrelated favorites; they cannot mix their rows.
const FAVORITE_LOCK_NAMESPACE = 0x46415653;

async function writeFavorite(
  userId: string,
  input: AddFavoriteInput,
  operation: 'add' | 'remove' | 'toggle',
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const lockKey = JSON.stringify([userId, input.climbUuid]);
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(${FAVORITE_LOCK_NAMESPACE}, hashtext(${lockKey}))`);
    const favoriteKey = and(
      eq(dbSchema.userFavorites.userId, userId),
      eq(dbSchema.userFavorites.climbUuid, input.climbUuid),
    );

    if (operation === 'remove') {
      await transaction.delete(dbSchema.userFavorites).where(favoriteKey);
      return false;
    }

    const [existingFavorite] = await transaction
      .select({ id: dbSchema.userFavorites.id })
      .from(dbSchema.userFavorites)
      .where(favoriteKey)
      .limit(1);
    if (existingFavorite) {
      if (operation === 'toggle') {
        // Remove every old angle variant; a heart belongs to the climb.
        await transaction.delete(dbSchema.userFavorites).where(favoriteKey);
        return false;
      }
      return true;
    }

    const [climb] = await transaction
      .select({ boardType: dbSchema.boardClimbs.boardType })
      .from(dbSchema.boardClimbs)
      .where(eq(dbSchema.boardClimbs.uuid, input.climbUuid))
      .limit(1);
    const inserted = await transaction
      .insert(dbSchema.userFavorites)
      .values({
        userId,
        climbUuid: input.climbUuid,
        // Old Postgres and SQLite schemas require both fields. The catalog's
        // board also keeps legacy list/export readers working through rollout.
        // Unknown catalog climbs remain accepted, as they were before this change.
        boardName: climb?.boardType ?? input.boardName ?? '',
        angle: input.angle ?? 0,
      })
      // Do not name either unique key: this writer must work with the old
      // four-column index, the new two-column index, or both during rollout.
      .onConflictDoNothing()
      .returning({ id: dbSchema.userFavorites.id });

    if (operation === 'toggle' && inserted.length === 0) {
      // An older backend that does not take the lock can still race us while
      // this compatibility release rolls out. Reconcile an insert conflict
      // as the second toggle instead of reporting a heart we did not add.
      await transaction.delete(dbSchema.userFavorites).where(favoriteKey);
      return false;
    }
    return true;
  });
}

export const favoriteMutations = {
  toggleFavorite: async (
    _: unknown,
    { input }: { input: ToggleFavoriteInput },
    ctx: ConnectionContext,
  ): Promise<ToggleFavoriteResult> => {
    requireAuthenticated(ctx);
    validateInput(ToggleFavoriteInputSchema, input, 'input');
    return { favorited: await writeFavorite(ctx.userId!, input, 'toggle') };
  },

  // Idempotent across board/angle variants and safe for queued offline retries.
  addFavorite: async (_: unknown, { input }: { input: AddFavoriteInput }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(AddFavoriteInputSchema, input, 'input');
    await writeFavorite(ctx.userId!, input, 'add');
    return true;
  },

  removeFavorite: async (
    _: unknown,
    { input }: { input: RemoveFavoriteInput },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(RemoveFavoriteInputSchema, input, 'input');
    await writeFavorite(ctx.userId!, input, 'remove');
    return true;
  },
};
