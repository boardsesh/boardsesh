import { eq, and, count } from 'drizzle-orm';
import type {
  ConnectionContext,
  UserProfile,
  AuroraCredentialStatus,
  DeleteAccountInfo,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';
import { getAuroraCredentialStatuses } from '../../../services/aurora-credentials';
import { userIsTester } from './tester';

export const userQueries = {
  /**
   * Get the authenticated user's profile
   */
  profile: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<UserProfile | null> => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      return null;
    }

    const [row] = await db
      .select({
        id: dbSchema.users.id,
        email: dbSchema.users.email,
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
      .where(eq(dbSchema.users.id, ctx.userId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName || row.name || undefined,
      avatarUrl: row.avatarUrl || row.image || undefined,
      isTester: await userIsTester(row.id),
    };
  },

  /**
   * Get all Aurora credentials for the authenticated user
   */
  auroraCredentials: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<AuroraCredentialStatus[]> => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      return [];
    }

    const credentials = await getAuroraCredentialStatuses(ctx.userId);

    return credentials.map((credential) => ({
      boardType: credential.boardType,
      username: credential.auroraUsername,
      userId: credential.auroraUserId ?? undefined,
      syncedAt: credential.lastSyncAt ?? undefined,
      hasToken: credential.syncStatus !== 'linked',
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

    const credential = (await getAuroraCredentialStatuses(ctx.userId)).find((status) => status.boardType === boardType);
    if (!credential) return null;

    return {
      boardType: credential.boardType,
      username: credential.auroraUsername,
      userId: credential.auroraUserId ?? undefined,
      syncedAt: credential.lastSyncAt ?? undefined,
      token: credential.syncStatus !== 'linked' ? '[ENCRYPTED]' : undefined,
    };
  },

  /**
   * Get info needed before account deletion (published climb count)
   */
  deleteAccountInfo: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<DeleteAccountInfo> => {
    requireAuthenticated(ctx);

    const result = await db
      .select({ count: count() })
      .from(dbSchema.boardClimbs)
      .where(and(eq(dbSchema.boardClimbs.userId, ctx.userId!), eq(dbSchema.boardClimbs.isDraft, false)));

    return {
      publishedClimbCount: result[0]?.count ?? 0,
    };
  },
};
