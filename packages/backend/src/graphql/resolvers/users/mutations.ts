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
import { mapProfileRow, PROFILE_SELECT } from './profile-row';
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
    { input }: { input: { displayName?: string | null; avatarUrl?: string | null; instagramUrl?: string | null } },
    ctx: ConnectionContext,
  ): Promise<UserProfile> => {
    requireAuthenticated(ctx);
    validateInput(UpdateProfileInputSchema, input, 'input');

    const userId = ctx.userId!;

    try {
      const row = await db.transaction(async (tx) => {
        const now = new Date();

        // Upsert only the fields the caller actually sent, so an omitted field
        // keeps its existing value (partial-update semantics). An explicit
        // null clears the field. Every field is optional in the input schema;
        // with none present there is nothing to write, and an empty `set`
        // would be invalid SQL — so skip the write entirely in that case.
        const profileUpdates: { displayName?: string | null; avatarUrl?: string | null; instagramUrl?: string | null } =
          {};
        if (input.displayName !== undefined) profileUpdates.displayName = input.displayName;
        if (input.avatarUrl !== undefined) profileUpdates.avatarUrl = input.avatarUrl;
        if (input.instagramUrl !== undefined) profileUpdates.instagramUrl = input.instagramUrl;

        if (Object.keys(profileUpdates).length > 0) {
          await tx
            .insert(dbSchema.userProfiles)
            .values({ userId, ...profileUpdates })
            .onConflictDoUpdate({
              target: dbSchema.userProfiles.userId,
              set: { ...profileUpdates, updatedAt: now },
            });
        }

        // Mirror the display name onto users.name, which is what the NextAuth
        // session (and therefore the web header/drawer) reads. The REST route
        // this mutation replaced did the same; without it, renaming yourself
        // leaves a stale name everywhere the session is the source.
        if (input.displayName !== undefined) {
          await tx
            .update(dbSchema.users)
            .set({ name: input.displayName || null, updatedAt: now })
            .where(eq(dbSchema.users.id, userId));
        }

        // One round trip to load the merged profile, mirroring the `profile`
        // query so both stay a single correlated-subquery select instead of the
        // previous 4 sequential, un-transactioned round trips (issue #3603).
        const [loadedRow] = await tx
          .select(PROFILE_SELECT)
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

      return mapProfileRow(row);
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
          hasInstagramUrl: input.instagramUrl !== undefined,
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
