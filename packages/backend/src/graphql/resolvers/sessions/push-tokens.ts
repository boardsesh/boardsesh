import type { ConnectionContext } from '@boardsesh/shared-schema';
import { activityPushTokens } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client';

export const pushTokenMutations = {
  /**
   * Register (upsert) an APNs device token for Live Activity push updates.
   * If the token already exists, updates the associated sessionId and updatedAt.
   */
  registerActivityPushToken: async (
    _: unknown,
    { sessionId, token }: { sessionId: string; token: string },
    _ctx: ConnectionContext,
  ) => {
    if (!sessionId || !token) {
      throw new Error('sessionId and token are required');
    }

    await db
      .insert(activityPushTokens)
      .values({
        token,
        sessionId,
      })
      .onConflictDoUpdate({
        target: activityPushTokens.token,
        set: {
          sessionId,
          updatedAt: new Date(),
        },
      });

    return true;
  },

  /**
   * Unregister an APNs device token by deleting it from the database.
   */
  unregisterActivityPushToken: async (
    _: unknown,
    { token }: { token: string },
    _ctx: ConnectionContext,
  ) => {
    if (!token) {
      throw new Error('token is required');
    }

    await db
      .delete(activityPushTokens)
      .where(eq(activityPushTokens.token, token));

    return true;
  },
};
