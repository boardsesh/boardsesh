import { eq, and } from 'drizzle-orm';
import type {
  ConnectionContext,
  UserProfile,
  AuroraCredentialStatus,
  DeleteAccountInput,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { userIsTester } from './tester';
import {
  UpdateProfileInputSchema,
  SaveAuroraCredentialInputSchema,
  BoardNameSchema,
  DeleteAccountInputSchema,
} from '../../../validation/schemas';
import {
  deleteAuroraCredential,
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
    { input }: { input: { displayName?: string; avatarUrl?: string } },
    ctx: ConnectionContext,
  ): Promise<UserProfile> => {
    requireAuthenticated(ctx);
    validateInput(UpdateProfileInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check if profile exists
    const existingProfile = await db
      .select()
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, userId))
      .limit(1);

    if (existingProfile.length === 0) {
      // Create new profile
      await db.insert(dbSchema.userProfiles).values({
        userId,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      });
    } else {
      // Update existing profile
      await db
        .update(dbSchema.userProfiles)
        .set({
          displayName: input.displayName ?? existingProfile[0].displayName,
          avatarUrl: input.avatarUrl ?? existingProfile[0].avatarUrl,
        })
        .where(eq(dbSchema.userProfiles.userId, userId));
    }

    // Fetch and return updated profile
    const users = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId)).limit(1);

    const profiles = await db
      .select()
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, userId))
      .limit(1);

    const user = users[0];
    const profile = profiles[0];

    return {
      id: user.id,
      email: user.email,
      displayName: profile?.displayName || user.name || undefined,
      avatarUrl: profile?.avatarUrl || user.image || undefined,
      isTester: await userIsTester(user.id),
    };
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

    return mapAuroraCredentialStatus(
      await saveAuroraCredential({
        userId: ctx.userId!,
        boardType: input.boardType as AuroraBoardName,
        username: input.username,
        password: input.password,
      }),
    );
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
