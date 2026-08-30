import { eq, and } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as Sentry from '@sentry/node';
import type {
  ConnectionContext,
  UserProfile,
  AuroraCredentialStatus,
  DeleteAccountInput,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { loadProfileRoleFlags } from './role-flags';
import { FAVORITE_COUNT_SUBQUERY } from './favorite-count';
import { logger } from '../../../utils/logger';
import { markErrorReported } from '../../../utils/sentry-dedupe';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import {
  UpdateProfileInputSchema,
  SaveAuroraCredentialInputSchema,
  BoardNameSchema,
  DeleteAccountInputSchema,
} from '../../../validation/schemas';
import {
  deleteAuroraCredential,
  DuplicateBoardLinkError,
  saveAuroraCredential,
  type AuroraCredentialStatus as RestAuroraCredentialStatus,
} from '../../../services/aurora-credentials';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { deleteClimbDependentRows, groupClimbUuidsByBoardType } from '../climbs/climb-cleanup';

function mapAuroraCredentialStatus(credential: RestAuroraCredentialStatus): AuroraCredentialStatus {
  return {
    boardType: credential.boardType,
    username: credential.auroraUsername,
    userId: credential.auroraUserId ?? undefined,
    syncedAt: credential.lastSyncAt ?? undefined,
    hasToken: credential.syncStatus !== 'linked',
  };
}

export const userMutations = {
  /**
   * Update the authenticated user's profile
   */
  updateProfile: async (
    _: unknown,
    { input }: { input: { displayName?: string; avatarUrl?: string } },
    ctx: ConnectionContext,
  ): Promise<UserProfile> => {
    requireAuthenticated(ctx);
    validateInput(UpdateProfileInputSchema, input, 'input');

    const userId = ctx.userId!;

    try {
      const row = await db.transaction(async (tx) => {
        // Upsert only the fields the caller actually sent, so an omitted field
        // keeps its existing value (partial-update semantics). Both fields are
        // optional in the input schema; with neither present there is nothing
        // to write, and an empty `set` would be invalid SQL — so skip the
        // write entirely in that case.
        const profileUpdates: { displayName?: string; avatarUrl?: string } = {};
        if (input.displayName !== undefined) profileUpdates.displayName = input.displayName;
        if (input.avatarUrl !== undefined) profileUpdates.avatarUrl = input.avatarUrl;

        if (Object.keys(profileUpdates).length > 0) {
          await tx
            .insert(dbSchema.userProfiles)
            .values({ userId, ...profileUpdates })
            .onConflictDoUpdate({ target: dbSchema.userProfiles.userId, set: profileUpdates });
        }

        // One round trip to load the merged profile, mirroring the `profile`
        // query so both stay a single correlated-subquery select instead of the
        // previous 4 sequential, un-transactioned round trips (issue #3603).
        const [loadedRow] = await tx
          .select({
            id: dbSchema.users.id,
            email: dbSchema.users.email,
            name: dbSchema.users.name,
            image: dbSchema.users.image,
            createdAt: dbSchema.users.createdAt,
            displayName: dbSchema.userProfiles.displayName,
            avatarUrl: dbSchema.userProfiles.avatarUrl,
            favoriteCount: FAVORITE_COUNT_SUBQUERY,
          })
          .from(dbSchema.users)
          .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
          .where(eq(dbSchema.users.id, userId))
          .limit(1);

        return loadedRow;
      });

      if (!row) {
        // The authenticated user row vanished mid-request — return a clean,
        // client-safe error instead of dereferencing undefined.
        throw new GraphQLError('Your account could not be found.', {
          extensions: { code: 'USER_NOT_FOUND' },
        });
      }

      const { isTester, isAdmin } = await loadProfileRoleFlags(row.id);

      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName || row.name || undefined,
        avatarUrl: row.avatarUrl || row.image || undefined,
        isTester,
        isAdmin,
        createdAt: row.createdAt.toISOString(),
        favoriteCount: row.favoriteCount,
      };
    } catch (error) {
      // A GraphQLError here is already client-safe and intentional (the
      // USER_NOT_FOUND above) — let it through untouched.
      if (error instanceof GraphQLError) throw error;

      // drizzle masks the driver failure as "Failed query: <sql>" and keeps the
      // real PostgresError on `.cause`. Capture the true cause (with its pg
      // code) to Sentry, and hand the client a generic message rather than the
      // raw SQL that used to leak straight through (issues #3603, #3183).
      const pgCode = getPostgresErrorCode(error);
      logger.error('[updateProfile] db failure', { userId, pgCode, error });
      Sentry.captureException(error instanceof Error ? (error.cause ?? error) : error, {
        tags: { source: 'updateProfile', transport: ctx.transport, pgCode: pgCode ?? 'unknown' },
        extra: {
          userId,
          hasDisplayName: input.displayName !== undefined,
          hasAvatarUrl: input.avatarUrl !== undefined,
        },
      });
      const clientSafeError = new GraphQLError('Could not save your profile. Please try again.', {
        extensions: { code: 'PROFILE_UPDATE_FAILED' },
      });
      // Defensive dedupe: we've already captured above, so mark the thrown
      // error reported. The targeted maskError leaves this clean GraphQLError
      // untouched (not a DB-leak), so no other capture path fires for it today
      // — but if one ever logs it, `wasErrorReported` keeps it to one event.
      markErrorReported(clientSafeError);
      throw clientSafeError;
    }
  },

  /**
   * Save Aurora credentials for a board type
   */
  saveAuroraCredential: async (
    _: unknown,
    { input }: { input: { boardType: string; username: string; password: string } },
    ctx: ConnectionContext,
  ): Promise<AuroraCredentialStatus> => {
    requireAuthenticated(ctx);

    // Validate input
    validateInput(SaveAuroraCredentialInputSchema, input, 'input');

    try {
      return mapAuroraCredentialStatus(
        await saveAuroraCredential({
          userId: ctx.userId!,
          boardType: input.boardType as AuroraBoardName,
          username: input.username,
          password: input.password,
        }),
      );
    } catch (error) {
      // Surface the duplicate-link rejection as a client-safe GraphQLError so its
      // stable code survives Yoga's production error masking.
      if (error instanceof DuplicateBoardLinkError) {
        throw new GraphQLError(error.message, { extensions: { code: error.code } });
      }
      throw error;
    }
  },

  /**
   * Delete Aurora credentials for a board type
   */
  deleteAuroraCredential: async (
    _: unknown,
    { boardType }: { boardType: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, boardType, 'boardType');

    const result = await deleteAuroraCredential(ctx.userId!, boardType as AuroraBoardName);

    return result.success || result.localCleared;
  },

  /**
   * Delete the current user's account.
   * 1. Deletes draft climbs
   * 2. Optionally removes setter name from published climbs
   * 3. Deletes the user row (cascading all related data)
   */
  deleteAccount: async (
    _: unknown,
    { input }: { input: DeleteAccountInput },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(DeleteAccountInputSchema, input, 'input');

    const userId = ctx.userId!;

    await db.transaction(async (tx) => {
      // Find this user's draft climbs first — the dependent-row cleanup below
      // needs the (boardType, uuid) pairs, and it must run before the drafts
      // themselves are deleted or the rows it targets would already be gone.
      const draftClimbs = await tx
        .select({ uuid: dbSchema.boardClimbs.uuid, boardType: dbSchema.boardClimbs.boardType })
        .from(dbSchema.boardClimbs)
        .where(and(eq(dbSchema.boardClimbs.userId, userId), eq(dbSchema.boardClimbs.isDraft, true)));

      // board_climb_stats/_history/board_beta_links have no FK back to
      // board_climbs (stats can legitimately arrive before their climb during
      // upstream sync), so deleting a draft here without also clearing these
      // strands an orphan row (issue #3943). Only the user's OWN drafts are
      // touched — published climbs survive account deletion with userId set
      // to null, and their stats must remain untouched.
      const draftsByBoardType = groupClimbUuidsByBoardType(draftClimbs);
      for (const [draftBoardType, uuids] of draftsByBoardType) {
        await deleteClimbDependentRows(tx, draftBoardType, uuids);
      }

      // Delete draft climbs created by this user
      await tx
        .delete(dbSchema.boardClimbs)
        .where(and(eq(dbSchema.boardClimbs.userId, userId), eq(dbSchema.boardClimbs.isDraft, true)));

      // Optionally remove setter name from published climbs
      if (input.removeSetterName) {
        await tx
          .update(dbSchema.boardClimbs)
          .set({ setterUsername: null })
          .where(and(eq(dbSchema.boardClimbs.userId, userId), eq(dbSchema.boardClimbs.isDraft, false)));
      }

      // Delete the user row — all related tables with onDelete: cascade
      // will be cleaned up automatically by the database.
      // boardClimbs.userId has onDelete: 'set null', so published climbs
      // will have their userId set to null (preserved).
      await tx.delete(dbSchema.users).where(eq(dbSchema.users.id, userId));
    });

    return true;
  },
};
