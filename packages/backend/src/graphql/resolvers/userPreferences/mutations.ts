import { and, eq } from 'drizzle-orm';
import type { ConnectionContext, SetUserPreferenceInput, UserPreference } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { SetUserPreferenceInputSchema } from '../../../validation/schemas';

export const userPreferencesMutations = {
  /**
   * Upsert a single user preference for the authenticated user.
   * Conflicts on (userId, key) update value + updatedAt.
   */
  setUserPreference: async (
    _: unknown,
    { input }: { input: SetUserPreferenceInput },
    ctx: ConnectionContext,
  ): Promise<UserPreference> => {
    requireAuthenticated(ctx);
    validateInput(SetUserPreferenceInputSchema, input, 'input');

    const userId = ctx.userId!;
    const now = new Date();

    const [row] = await db
      .insert(dbSchema.userPreferences)
      .values({
        userId,
        key: input.key,
        value: input.value,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [dbSchema.userPreferences.userId, dbSchema.userPreferences.key],
        set: {
          value: input.value,
          updatedAt: now,
        },
      })
      .returning();

    return {
      key: row.key,
      value: row.value,
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  /**
   * Delete a single user preference for the authenticated user by key.
   * Idempotent — returns true regardless of whether a row existed.
   */
  deleteUserPreference: async (_: unknown, { key }: { key: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);

    await db
      .delete(dbSchema.userPreferences)
      .where(and(eq(dbSchema.userPreferences.userId, ctx.userId!), eq(dbSchema.userPreferences.key, key)));

    return true;
  },
};
