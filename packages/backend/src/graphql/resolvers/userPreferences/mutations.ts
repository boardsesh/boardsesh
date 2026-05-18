import { and, eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SetUserPreferenceInput, UserPreference } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { SetUserPreferenceInputSchema, UserPreferenceKeySchema } from '../../../validation/schemas';

/**
 * Maximum number of preference rows per user. Bounds storage growth from a
 * misbehaving or hostile authenticated client that loops `setUserPreference`
 * with unique keys. Existing keys can still be updated — the cap only
 * blocks NEW keys after the user is at the limit.
 *
 * 100 is well above the ~10 keys the real client populates and leaves
 * headroom for future per-feature flags without raising again.
 */
const MAX_PREFERENCES_PER_USER = 100;

export const userPreferencesMutations = {
  /**
   * Upsert a single user preference for the authenticated user.
   * Conflicts on (userId, key) update value + updatedAt.
   *
   * Caps new-key insertion at MAX_PREFERENCES_PER_USER to prevent a
   * runaway client from filling the table; updates to existing keys
   * bypass the cap since they don't grow the row count.
   */
  setUserPreference: async (
    _: unknown,
    { input }: { input: SetUserPreferenceInput },
    ctx: ConnectionContext,
  ): Promise<UserPreference> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'setUserPreference');
    validateInput(SetUserPreferenceInputSchema, input, 'input');

    const userId = ctx.userId!;
    const now = new Date();

    // Quota check: count existing rows + check whether this key already
    // exists. We do both in one round-trip via a single select so the
    // cap costs at most one extra query per write. A race between two
    // parallel writes can briefly overshoot by 1, which is acceptable —
    // the cap is a storage-growth bound, not a hard security boundary.
    const [quota] = await db
      .select({
        total: sql<number>`count(*)::int`,
        keyExists: sql<boolean>`bool_or(${dbSchema.userPreferences.key} = ${input.key})`,
      })
      .from(dbSchema.userPreferences)
      .where(eq(dbSchema.userPreferences.userId, userId));

    const totalKeys = quota?.total ?? 0;
    const keyAlreadyExists = quota?.keyExists ?? false;

    if (!keyAlreadyExists && totalKeys >= MAX_PREFERENCES_PER_USER) {
      throw new Error(
        `Preference limit reached: a single user may store at most ${MAX_PREFERENCES_PER_USER} preference keys`,
      );
    }

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
    await applyRateLimit(ctx, 60, 'deleteUserPreference');
    validateInput(UserPreferenceKeySchema, key, 'key');

    await db
      .delete(dbSchema.userPreferences)
      .where(and(eq(dbSchema.userPreferences.userId, ctx.userId!), eq(dbSchema.userPreferences.key, key)));

    return true;
  },
};
