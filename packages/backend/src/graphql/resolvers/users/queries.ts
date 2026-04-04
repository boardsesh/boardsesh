import { eq, and, count } from 'drizzle-orm';
import type { ConnectionContext, UserProfile, AuroraCredentialStatus, DeleteAccountInfo } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export const userQueries = {
  /**
   * Get the authenticated user's profile
   */
  profile: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<UserProfile | null> => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      return null;
    }

    const users = await db
      .select()
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, ctx.userId))
      .limit(1);

    if (users.length === 0) {
      return null;
    }

    const user = users[0];

    // Get profile if exists
    const profiles = await db
      .select()
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, ctx.userId))
      .limit(1);

    const profile = profiles[0];

    return {
      id: user.id,
      email: user.email,
      displayName: profile?.displayName || user.name || undefined,
      avatarUrl: profile?.avatarUrl || user.image || undefined,
    };
  },

  /**
   * Get all Aurora credentials for the authenticated user
   */
  auroraCredentials: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<AuroraCredentialStatus[]> => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      return [];
    }

    const credentials = await db
      .select()
      .from(dbSchema.auroraCredentials)
      .where(eq(dbSchema.auroraCredentials.userId, ctx.userId));

    return credentials.map(c => ({
      boardType: c.boardType,
      username: c.encryptedUsername, // Username is stored as-is (not encrypted)
      userId: c.auroraUserId || undefined,
      syncedAt: c.lastSyncAt?.toISOString() || undefined,
      hasToken: !!c.auroraToken,
    }));
  },

  /**
   * Get a specific Aurora credential for the authenticated user by board type
   */
  auroraCredential: async (_: unknown, { boardType }: { boardType: string }, ctx: ConnectionContext) => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      return null;
    }

    validateInput(BoardNameSchema, boardType, 'boardType');

    const credentials = await db
      .select()
      .from(dbSchema.auroraCredentials)
      .where(
        and(
          eq(dbSchema.auroraCredentials.userId, ctx.userId),
          eq(dbSchema.auroraCredentials.boardType, boardType)
        )
      )
      .limit(1);

    if (credentials.length === 0) {
      return null;
    }

    const c = credentials[0];
    return {
      boardType: c.boardType,
      username: c.encryptedUsername, // Username is stored as-is (not encrypted)
      userId: c.auroraUserId || undefined,
      syncedAt: c.lastSyncAt?.toISOString() || undefined,
      // Note: We don't expose the actual token for security
      token: c.auroraToken ? '[ENCRYPTED]' : undefined,
    };
  },

  /**
   * Get info needed before account deletion (published climb count)
   */
  deleteAccountInfo: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext
  ): Promise<DeleteAccountInfo> => {
    requireAuthenticated(ctx);

    const result = await db
      .select({ count: count() })
      .from(dbSchema.boardClimbs)
      .where(
        and(
          eq(dbSchema.boardClimbs.userId, ctx.userId!),
          eq(dbSchema.boardClimbs.isDraft, false)
        )
      );

    return {
      publishedClimbCount: result[0]?.count ?? 0,
    };
  },
};
