import { eq, and } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as Sentry from '@sentry/node';
import type {
  ConnectionContext,
  UserProfile,
  AuroraCredentialStatus,
  DeleteAccountInput,
  ProviderSyncRequest,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { coalesceInteractiveRun, ensureProviderSyncControl, lockProviderSyncControl } from '@boardsesh/db/queries';
import { mapProfileRow, PROFILE_SELECT } from './profile-row';
import { logger } from '../../../utils/logger';
import { markErrorReported } from '../../../utils/sentry-dedupe';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import {
  UpdateProfileInputSchema,
  SaveAuroraCredentialInputSchema,
  AuroraBoardNameSchema,
  DeleteAccountInputSchema,
  ProviderSyncBoardTypeSchema,
} from '../../../validation/schemas';
import {
  deleteAuroraCredential,
  DuplicateBoardLinkError,
  requestProviderSyncOn,
  saveAuroraCredential,
} from '../../../services/aurora-credentials';
import { mapAuroraCredentialStatus } from './credential-status';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { deleteClimbDependentRows, groupClimbUuidsByBoardType } from '../climbs/climb-cleanup';

/** Credential statuses a sync can run from; `expired` needs a relink first. */
const SYNCABLE_CREDENTIAL_STATUSES = ['pending', 'active', 'error'];

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
          // `updated_at` only has `defaultNow()`, so without stamping it here
          // the column records profile CREATION and never moves again. The
          // setters sitemap reads it as the identity half of a page's
          // `<lastmod>` (#5206): unstamped, a display-name or avatar change
          // rewrites the page's h1, summary, avatar and JSON-LD while the
          // sitemap goes on advertising the old date.
          const stampedUpdates = { ...profileUpdates, updatedAt: now };
          await tx
            .insert(dbSchema.userProfiles)
            .values({ userId, ...stampedUpdates })
            .onConflictDoUpdate({
              target: dbSchema.userProfiles.userId,
              set: stampedUpdates,
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
   * "Sync now": queue an interactive sync of one linked board account, or join
   * the one already waiting. The control row is locked for the whole decision,
   * so two taps racing each other queue one run between them.
   */
  requestProviderSync: async (
    _: unknown,
    { boardType }: { boardType: string },
    ctx: ConnectionContext,
  ): Promise<ProviderSyncRequest> => {
    requireAuthenticated(ctx);
    validateInput(ProviderSyncBoardTypeSchema, boardType, 'boardType');
    await applyRateLimit(ctx, 5, 'requestProviderSync');
    const userId = ctx.userId!;
    const key = { userId, boardType };

    return db.transaction(async (tx) => {
      let control = await lockProviderSyncControl(tx, key);
      const [credential] = await tx
        .select({ syncStatus: dbSchema.auroraCredentials.syncStatus })
        .from(dbSchema.auroraCredentials)
        .where(and(eq(dbSchema.auroraCredentials.userId, userId), eq(dbSchema.auroraCredentials.boardType, boardType)));
      const syncable = credential && SYNCABLE_CREDENTIAL_STATUSES.includes(credential.syncStatus);
      if (syncable && !control) {
        // A credential linked before control rows existed. Create the row
        // without a new generation (concurrent taps land on one row), then lock it.
        await ensureProviderSyncControl(tx, key);
        control = await lockProviderSyncControl(tx, key);
      }
      if (!syncable || !control?.linked) {
        throw new GraphQLError('Link this board account before syncing it.', {
          extensions: { code: 'PROVIDER_NOT_LINKED' },
        });
      }
      const { linkGeneration } = control;

      const waiting = await coalesceInteractiveRun(tx, key);
      if (waiting) return { runId: waiting.runId, status: waiting.status, coalesced: true };

      const runId = await requestProviderSyncOn(tx, { ...key, linkGeneration, requestedBy: 'manual' });
      if (!runId) {
        throw new GraphQLError('Syncing this board from the app is not switched on yet.', {
          extensions: { code: 'PROVIDER_SYNC_UNAVAILABLE' },
        });
      }
      return { runId, status: 'queued', coalesced: false };
    });
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
    // Aurora-only, matching saveAuroraCredential: a non-Aurora board has no
    // Aurora credential row to delete, and the cast below would otherwise claim
    // a type the value does not have.
    validateInput(AuroraBoardNameSchema, boardType, 'boardType');

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
