import { and, eq, or, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext, RevertGymClaimResult } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { transactionWithAfterCommit } from '../../../db/after-commit';
import { sendGymClaimRevokedEmail } from '../../../email/email-service';
import { logger } from '../../../utils/logger';
import { RevertGymClaimInputSchema } from '../../../validation/schemas';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { emailClaimantAfterCommit, sendClaimDeniedNotice } from './gym-claims';
import { requireAdmin } from './roles';

/** `extensions.code` on every refusal, so the admin panel can branch without reading the message. */
export const GYM_CLAIM_REVERT_CODES = {
  notFound: 'GYM_CLAIM_REVERT_NOT_FOUND',
  notApproved: 'GYM_CLAIM_REVERT_NOT_APPROVED',
  ownerChanged: 'GYM_CLAIM_REVERT_OWNER_CHANGED',
} as const;

const REVERT_MUTATION_LIMIT = 10;

/**
 * Take back an approved claim (docs/product/gym-claims.md, "Revert").
 *
 * `reassignGymOwner` can't do this: it keeps the outgoing owner on as a gym
 * admin, and the location sync treats any approved claim as owner-curated, so a
 * gym handed back to SYSTEM that way would stay frozen and keep its claimant.
 * In one transaction, under the gym's row lock (the same lock claims and
 * handovers take):
 *
 * 1. The gym goes back to SYSTEM. Its sync freeze is cleared, so the location
 *    sync curates it again and overwrites whatever the claimant changed in the
 *    fields it owns. The website stays but loses the owner's vouch, so it can't
 *    carry a domain claim by the person it was just taken from.
 * 2. The claim becomes `revoked`. It keeps `reviewed_by` null, so it still
 *    counts as the account's one auto-approval.
 * 3. The claimant's membership row and every gym member or editor added since
 *    the claim was approved are removed. A real prior owner, kept on as admin
 *    when the claim applied, stays.
 * 4. A `gym_owner_reassignments` row records it, with the freeze either side.
 *    That row also makes a claim filed before the revert read as superseded.
 * 5. The claimant gets the in-app `gym_claim_denied` notice (flag permitting)
 *    and, once committed, an email.
 *
 * Refused when the claimant no longer owns the gym: someone moved it since,
 * and the handover panel is the tool for moving it again.
 */
export const socialGymClaimRevertMutations = {
  revertGymClaim: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<RevertGymClaimResult> => {
    // Global admins only: `requireAdmin` with no board type admits no scoped role.
    await requireAdmin(ctx);
    const performedBy = ctx.userId;
    if (!performedBy) throw new Error('Authentication required to perform this operation');
    await applyRateLimit(ctx, REVERT_MUTATION_LIMIT, 'revertGymClaim');
    const { claimId, reason } = validateInput(RevertGymClaimInputSchema, input, 'input');

    const notFound = () =>
      new GraphQLError('That claim or its gym is gone.', { extensions: { code: GYM_CLAIM_REVERT_CODES.notFound } });

    const [located] = await db
      .select({ gymId: dbSchema.gymClaims.gymId })
      .from(dbSchema.gymClaims)
      .where(eq(dbSchema.gymClaims.id, claimId))
      .limit(1);
    if (!located) throw notFound();

    const result = await transactionWithAfterCommit(async (tx) => {
      // Gym row before claim row, the order applyGymClaim and claim filing use.
      const [gym] = await tx
        .select()
        .from(dbSchema.gyms)
        .where(eq(dbSchema.gyms.id, located.gymId))
        .limit(1)
        .for('update');
      const [claim] = await tx
        .select()
        .from(dbSchema.gymClaims)
        .where(eq(dbSchema.gymClaims.id, claimId))
        .limit(1)
        .for('update');
      // A merge can move the claim to another gym between the two reads.
      if (!gym || !claim || claim.gymId !== gym.id || gym.deletedAt || gym.mergedIntoGymId !== null) {
        throw notFound();
      }
      if (claim.status !== 'approved') {
        throw new GraphQLError("This claim isn't approved, so there is nothing to revert.", {
          extensions: { code: GYM_CLAIM_REVERT_CODES.notApproved },
        });
      }
      if (gym.ownerId !== claim.claimantUserId) {
        throw new GraphQLError(
          'This gym changed hands after the claim. Use Move gym ownership to hand it on from its current owner.',
          { extensions: { code: GYM_CLAIM_REVERT_CODES.ownerChanged } },
        );
      }

      // When the claim applied: its decision row (clock time, microseconds kept
      // in SQL), or the claim's own resolution time for a claim from before
      // decision rows existed. Membership rows written in the approving
      // transaction itself (a real prior owner kept on as admin) are stamped
      // with that transaction's start, which is earlier, so they stay.
      const approvedAt = sql`COALESCE((${tx
        .select({ decidedAt: dbSchema.gymClaimOwnershipDecisions.decidedAt })
        .from(dbSchema.gymClaimOwnershipDecisions)
        .where(eq(dbSchema.gymClaimOwnershipDecisions.claimId, claim.id))}), (${tx
        .select({ updatedAt: dbSchema.gymClaims.updatedAt })
        .from(dbSchema.gymClaims)
        .where(eq(dbSchema.gymClaims.id, claim.id))}))`;

      const moved = await tx
        .update(dbSchema.gyms)
        .set({
          ownerId: SYSTEM_BOARD_OWNER_ID,
          syncFrozenAt: null,
          // `website` and its vouch are always written together (#3431). The
          // vouch belonged to the owner this revert removes.
          website: sql`${dbSchema.gyms.website}`,
          websiteVouchedByOwner: false,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(dbSchema.gyms.id, gym.id), eq(dbSchema.gyms.ownerId, claim.claimantUserId)))
        .returning({ syncFrozenAt: dbSchema.gyms.syncFrozenAt });
      if (moved.length !== 1) {
        throw new GraphQLError('This gym changed hands while the revert ran.', {
          extensions: { code: GYM_CLAIM_REVERT_CODES.ownerChanged },
        });
      }

      const removedMembers = await tx
        .delete(dbSchema.gymMembers)
        .where(
          and(
            eq(dbSchema.gymMembers.gymId, gym.id),
            or(
              eq(dbSchema.gymMembers.userId, claim.claimantUserId),
              sql`${dbSchema.gymMembers.createdAt} >= ${approvedAt}`,
            ),
          ),
        )
        .returning({ userId: dbSchema.gymMembers.userId });

      await tx
        .update(dbSchema.gymClaims)
        .set({ status: 'revoked', updatedAt: sql`clock_timestamp()` })
        .where(and(eq(dbSchema.gymClaims.id, claim.id), eq(dbSchema.gymClaims.status, 'approved')));

      await tx.insert(dbSchema.gymOwnerReassignments).values({
        gymUuid: gym.uuid,
        previousOwnerId: claim.claimantUserId,
        newOwnerId: SYSTEM_BOARD_OWNER_ID,
        syncFrozenAtBefore: gym.syncFrozenAt,
        syncFrozenAtAfter: moved[0].syncFrozenAt,
        reason: reason ? `Claim ${claim.id} reverted: ${reason}` : `Claim ${claim.id} reverted`,
        performedBy,
        // After the gym row lock, like every other ownership event.
        createdAt: sql`clock_timestamp()`,
      });

      await sendClaimDeniedNotice(tx, claim);
      emailClaimantAfterCommit(tx, claim, sendGymClaimRevokedEmail);

      return {
        claimId: String(claim.id),
        gymUuid: gym.uuid,
        gymName: gym.name,
        removedMemberCount: removedMembers.length,
      };
    });

    logger.info('Gym claim reverted by global admin', {
      claimId: result.claimId,
      gymUuid: result.gymUuid,
      removedMemberCount: result.removedMemberCount,
      performedBy,
    });
    return result;
  },
};
