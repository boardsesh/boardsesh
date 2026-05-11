import { and, eq } from 'drizzle-orm';
import type { ConnectionContext, UserPreference } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated } from '../shared/helpers';

/**
 * Map a raw DB row to the GraphQL UserPreference shape.
 * Stringifies the timestamp; `value` is already jsonb so it round-trips as-is.
 */
function rowToPreference(row: { key: string; value: unknown; updatedAt: Date }): UserPreference {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const userPreferencesQueries = {
  /**
   * Get a single user preference for the authenticated user by key.
   * Returns null if the preference is not set.
   */
  userPreference: async (
    _: unknown,
    { key }: { key: string },
    ctx: ConnectionContext,
  ): Promise<UserPreference | null> => {
    requireAuthenticated(ctx);

    const rows = await db
      .select()
      .from(dbSchema.userPreferences)
      .where(and(eq(dbSchema.userPreferences.userId, ctx.userId!), eq(dbSchema.userPreferences.key, key)))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return rowToPreference(rows[0]);
  },

  /**
   * Get all user preferences for the authenticated user.
   */
  userPreferences: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<UserPreference[]> => {
    requireAuthenticated(ctx);

    const rows = await db
      .select()
      .from(dbSchema.userPreferences)
      .where(eq(dbSchema.userPreferences.userId, ctx.userId!));

    return rows.map(rowToPreference);
  },
};
