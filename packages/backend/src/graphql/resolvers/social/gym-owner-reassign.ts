import { and, eq, ilike, isNull, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  ConnectionContext,
  GymOwnershipLookupResult,
  GymOwnershipSummary,
  GymOwnershipUserSummary,
  ReassignGymOwnerResult,
} from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { GymOwnershipLookupInputSchema, ReassignGymOwnerInputSchema } from '../../../validation/schemas';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { requireAdmin } from './roles';

const OWNERSHIP_LOOKUP_QUERY_LIMIT = 30;
const REASSIGN_MUTATION_LIMIT = 10;

/**
 * `extensions.code` values every rejection carries, so the admin panel can
 * branch on the outcome instead of scraping a message. Follows the convention
 * #4515 set for claim errors.
 */
export const GYM_REASSIGN_CODES = {
  notFound: 'GYM_REASSIGN_TARGET_NOT_FOUND',
  merged: 'GYM_REASSIGN_TARGET_MERGED',
  ownerChanged: 'GYM_REASSIGN_OWNER_CHANGED',
  ownerUnchanged: 'GYM_REASSIGN_OWNER_UNCHANGED',
  newOwnerNotFound: 'GYM_REASSIGN_NEW_OWNER_NOT_FOUND',
} as const;

function nullableIsoString(timestamp: Date | string | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

/** Display label for an account: profile display name, then account name, then email. */
async function loadUserLabels(userIds: string[]): Promise<Map<string, { label: string; email: string | null }>> {
  const labels = new Map<string, { label: string; email: string | null }>();
  if (userIds.length === 0) return labels;
  const rows = await db
    .select({
      id: dbSchema.users.id,
      name: dbSchema.users.name,
      email: dbSchema.users.email,
      displayName: dbSchema.userProfiles.displayName,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(or(...userIds.map((userId) => eq(dbSchema.users.id, userId))));
  for (const row of rows) {
    labels.set(row.id, { label: row.displayName || row.name || row.email, email: row.email });
  }
  return labels;
}

/**
 * Resolve the gym half of a handover. An exact UUID or slug wins; otherwise the
 * first case-insensitive name match, so an admin can paste either.
 */
async function lookupGym(gymQuery: string): Promise<GymOwnershipSummary | null> {
  const gymColumns = {
    uuid: dbSchema.gyms.uuid,
    slug: dbSchema.gyms.slug,
    name: dbSchema.gyms.name,
    ownerId: dbSchema.gyms.ownerId,
    syncFrozenAt: dbSchema.gyms.syncFrozenAt,
    deletedAt: dbSchema.gyms.deletedAt,
    mergedIntoGymId: dbSchema.gyms.mergedIntoGymId,
  };

  const [exact] = await db
    .select(gymColumns)
    .from(dbSchema.gyms)
    .where(or(eq(dbSchema.gyms.uuid, gymQuery), eq(dbSchema.gyms.slug, gymQuery)))
    .limit(1);
  const [gym] = exact
    ? [exact]
    : await db
        .select(gymColumns)
        .from(dbSchema.gyms)
        .where(ilike(dbSchema.gyms.name, `%${gymQuery}%`))
        .orderBy(dbSchema.gyms.name)
        .limit(1);
  if (!gym) return null;

  const labels = await loadUserLabels([gym.ownerId]);
  return {
    gymUuid: gym.uuid,
    slug: gym.slug,
    name: gym.name,
    currentOwnerId: gym.ownerId,
    currentOwnerLabel: labels.get(gym.ownerId)?.label ?? null,
    currentOwnerIsSystem: gym.ownerId === SYSTEM_BOARD_OWNER_ID,
    syncFrozenAt: nullableIsoString(gym.syncFrozenAt),
    isDeleted: gym.deletedAt !== null,
    isMerged: gym.mergedIntoGymId !== null,
  };
}

/** Resolve the incoming owner from an account email (case-insensitive) or a user id. */
async function lookupUser(newOwnerQuery: string): Promise<GymOwnershipUserSummary | null> {
  const [row] = await db
    .select({
      id: dbSchema.users.id,
      name: dbSchema.users.name,
      email: dbSchema.users.email,
      displayName: dbSchema.userProfiles.displayName,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(or(eq(dbSchema.users.id, newOwnerQuery), ilike(dbSchema.users.email, newOwnerQuery)))
    .limit(1);
  if (!row) return null;
  return { userId: row.id, label: row.displayName || row.name || row.email, email: row.email };
}

export const socialGymOwnerReassignQueries = {
  gymOwnershipLookup: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<GymOwnershipLookupResult> => {
    // `requireAdmin` with no board type admits global admins only: `hasAdmin`
    // keeps a role row when its `boardType` is null (global) or equal to the
    // argument, and `undefined` matches neither 'kilter' nor 'tension'. A
    // board-scoped community admin must not be able to move gym ownership.
    await requireAdmin(ctx);
    await applyRateLimit(ctx, OWNERSHIP_LOOKUP_QUERY_LIMIT, 'gymOwnershipLookup');
    const validated = validateInput(GymOwnershipLookupInputSchema, input, 'input');

    const [gym, newOwner] = await Promise.all([lookupGym(validated.gymQuery), lookupUser(validated.newOwnerQuery)]);
    return { gym, newOwner };
  },
};

export const socialGymOwnerReassignMutations = {
  reassignGymOwner: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<ReassignGymOwnerResult> => {
    // Global-admin only, for the same reason as the lookup above.
    await requireAdmin(ctx);
    const performedBy = ctx.userId;
    if (!performedBy) {
      throw new Error('Authentication required to perform this operation');
    }
    await applyRateLimit(ctx, REASSIGN_MUTATION_LIMIT, 'reassignGymOwner');
    const validated = validateInput(ReassignGymOwnerInputSchema, input, 'input');

    const result = await db.transaction(async (tx): Promise<ReassignGymOwnerResult> => {
      const [gym] = await tx
        .select({
          id: dbSchema.gyms.id,
          uuid: dbSchema.gyms.uuid,
          name: dbSchema.gyms.name,
          ownerId: dbSchema.gyms.ownerId,
          syncFrozenAt: dbSchema.gyms.syncFrozenAt,
          mergedIntoGymId: dbSchema.gyms.mergedIntoGymId,
        })
        .from(dbSchema.gyms)
        // A soft-deleted listing has no owner to hand over — it reads as gone to
        // everyone else, so it reads as gone here too.
        .where(and(eq(dbSchema.gyms.uuid, validated.gymUuid), isNull(dbSchema.gyms.deletedAt)))
        .limit(1)
        .for('update');

      if (!gym) {
        throw new GraphQLError('Gym not found.', { extensions: { code: GYM_REASSIGN_CODES.notFound } });
      }
      if (gym.mergedIntoGymId !== null) {
        throw new GraphQLError('A merged gym has no ownership of its own; reassign the surviving listing instead.', {
          extensions: { code: GYM_REASSIGN_CODES.merged },
        });
      }
      // Optimistic concurrency, same shape as the location-sync freeze clear:
      // the admin confirmed a handover away from a specific person, so a
      // different current owner means the confirmation is stale.
      if (gym.ownerId !== validated.expectedCurrentOwnerId) {
        throw new GraphQLError('This gym changed hands after the confirmation opened.', {
          extensions: { code: GYM_REASSIGN_CODES.ownerChanged },
        });
      }
      if (gym.ownerId === validated.newOwnerId) {
        throw new GraphQLError('That account already owns this gym.', {
          extensions: { code: GYM_REASSIGN_CODES.ownerUnchanged },
        });
      }

      const [newOwner] = await tx
        .select({ id: dbSchema.users.id })
        .from(dbSchema.users)
        .where(eq(dbSchema.users.id, validated.newOwnerId))
        .limit(1);
      if (!newOwner) {
        throw new GraphQLError('That account no longer exists.', {
          extensions: { code: GYM_REASSIGN_CODES.newOwnerNotFound },
        });
      }

      const previousOwnerId = gym.ownerId;
      const moved = await tx
        .update(dbSchema.gyms)
        // `syncFrozenAt` is DELIBERATELY ABSENT from this SET clause, and must
        // stay absent — including for a gym where it is NULL. An owner change is
        // not a curation event: writing a fresh timestamp would freeze a listing
        // location sync is still allowed to maintain, and clearing or defaulting
        // it would unfreeze a listing whose owner-authored edits sync would then
        // overwrite. Adding it here "for consistency" is the regression this
        // comment exists to stop; `gym_owner_reassignments` records the marker
        // either side of this write so a test can prove it did not move.
        .set({ ownerId: validated.newOwnerId, updatedAt: new Date() })
        .where(and(eq(dbSchema.gyms.id, gym.id), eq(dbSchema.gyms.ownerId, previousOwnerId)))
        .returning({ syncFrozenAt: dbSchema.gyms.syncFrozenAt });
      if (moved.length !== 1) {
        throw new GraphQLError('The gym ownership could not be moved.', {
          extensions: { code: GYM_REASSIGN_CODES.ownerChanged },
        });
      }

      // Mirror applyGymClaim's membership handling so the two paths agree: a
      // real outgoing owner stays on as a gym admin (upsert, so an existing
      // lower role is upgraded rather than left behind), never the system
      // import account; and the incoming owner's leftover membership row goes,
      // since ownership already outranks it.
      if (previousOwnerId !== SYSTEM_BOARD_OWNER_ID) {
        await tx
          .insert(dbSchema.gymMembers)
          .values({ gymId: gym.id, userId: previousOwnerId, role: 'admin' })
          .onConflictDoUpdate({
            target: [dbSchema.gymMembers.gymId, dbSchema.gymMembers.userId],
            set: { role: 'admin' },
          });
      }
      await tx
        .delete(dbSchema.gymMembers)
        .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, validated.newOwnerId)));

      await tx.insert(dbSchema.gymOwnerReassignments).values({
        gymUuid: gym.uuid,
        previousOwnerId,
        newOwnerId: validated.newOwnerId,
        syncFrozenAtBefore: gym.syncFrozenAt,
        syncFrozenAtAfter: moved[0].syncFrozenAt,
        reason: validated.reason,
        performedBy,
      });

      return {
        gymUuid: gym.uuid,
        gymName: gym.name,
        previousOwnerId,
        newOwnerId: validated.newOwnerId,
        syncFrozenAt: nullableIsoString(moved[0].syncFrozenAt),
      };
    });

    logger.info('Gym ownership reassigned by global admin', {
      gymUuid: result.gymUuid,
      previousOwnerId: result.previousOwnerId,
      newOwnerId: result.newOwnerId,
      performedBy,
    });
    return result;
  },
};
