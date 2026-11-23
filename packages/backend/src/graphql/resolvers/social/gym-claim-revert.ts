import { and, eq, ne, or, sql } from 'drizzle-orm';
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
  /** The claim has no record of moving this gym: approved before records began, or a no-op approval. */
  notTransferred: 'GYM_CLAIM_REVERT_NOT_TRANSFERRED',
  /** Someone moved the gym after the claim: an admin handover, or a later claim. */
  ownerChanged: 'GYM_CLAIM_REVERT_OWNER_CHANGED',
  /** The claim took the gym from a person (or from an owner nobody recorded), not from SYSTEM. */
  priorOwner: 'GYM_CLAIM_REVERT_PRIOR_OWNER',
} as const;

const REVERT_MUTATION_LIMIT = 10;

/**
 * Take back an approved claim (docs/product/gym-claims.md, "Revert").
 *
 * `reassignGymOwner` can't do this: it keeps the outgoing owner on as a gym
 * admin, and the location sync treats any approved claim as owner-curated, so a
 * gym handed back to SYSTEM that way would stay frozen and keep its claimant.
 *
 * It only undoes the simple case, and refuses everything else with a stable
 * code (`GYM_CLAIM_REVERT_CODES`) and a pointer to Move gym ownership:
 *
 * - the claim's ownership decision row says it moved this gym (`didTransfer`);
 * - the claimant still owns the gym;
 * - nothing moved the gym after that decision: no later decision row and no
 *   later `gym_owner_reassignments` row for it;
 * - the owner before the claim was SYSTEM (the decision row's
 *   `previousOwnerId`). A claim that displaced a real owner needs that owner
 *   back, not SYSTEM.
 *
 * Then, in one transaction under the gym's row lock (the same lock claims,
 * handovers and staff changes take):
 *
 * 1. The gym goes back to SYSTEM. Its sync freeze is cleared, so the location
 *    sync curates it again and overwrites whatever the claimant changed in the
 *    fields it owns. The website stays but loses the owner's vouch, so it can't
 *    carry a domain claim by the person it was just taken from.
 * 2. Every approved claim on the gym becomes `revoked`, this one and any older
 *    one, so the sync stops reading the gym as owner-curated. They keep
 *    `reviewed_by`, so an auto-approval still counts as its account's one.
 * 3. The claimant's membership row and every gym member or editor added since
 *    the claim was approved are removed. Staff from before the claim stay.
 * 4. A `gym_owner_reassignments` row records it, with the freeze either side.
 *    That row also makes a claim filed before the revert read as superseded.
 * 5. Once committed, the claimant gets the in-app `gym_claim_denied` notice
 *    (flag permitting) and an email. Both are best effort: neither can undo
 *    the revert.
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

    const { result, claim } = await transactionWithAfterCommit(async (tx) => {
      // Gym row before claim row, the order applyGymClaim and claim filing use.
      const [gym] = await tx
        .select()
        .from(dbSchema.gyms)
        .where(eq(dbSchema.gyms.id, located.gymId))
        .limit(1)
        .for('update');
      const [lockedClaim] = await tx
        .select()
        .from(dbSchema.gymClaims)
        .where(eq(dbSchema.gymClaims.id, claimId))
        .limit(1)
        .for('update');
      // A merge can move the claim to another gym between the two reads.
      if (!gym || !lockedClaim || lockedClaim.gymId !== gym.id || gym.deletedAt || gym.mergedIntoGymId !== null) {
        throw notFound();
      }
      if (lockedClaim.status !== 'approved') {
        throw new GraphQLError("This claim isn't approved, so there is nothing to revert.", {
          extensions: { code: GYM_CLAIM_REVERT_CODES.notApproved },
        });
      }

      const [decision] = await tx
        .select({
          gymUuid: dbSchema.gymClaimOwnershipDecisions.gymUuid,
          didTransfer: dbSchema.gymClaimOwnershipDecisions.didTransfer,
          previousOwnerId: dbSchema.gymClaimOwnershipDecisions.previousOwnerId,
        })
        .from(dbSchema.gymClaimOwnershipDecisions)
        .where(eq(dbSchema.gymClaimOwnershipDecisions.claimId, lockedClaim.id))
        .limit(1);
      // The decision's uuid is the gym that actually changed; a merge since
      // can point the claim at a survivor this claim never moved.
      if (!decision || !decision.didTransfer || decision.gymUuid !== gym.uuid) {
        throw new GraphQLError(
          "There's no record of this claim moving the gym, so it can't be reverted. Use Move gym ownership instead.",
          { extensions: { code: GYM_CLAIM_REVERT_CODES.notTransferred } },
        );
      }

      // When the claim applied, as a subquery so the comparisons keep the
      // microseconds the JS Date mapper drops.
      const approvedAt = sql`(${tx
        .select({ decidedAt: dbSchema.gymClaimOwnershipDecisions.decidedAt })
        .from(dbSchema.gymClaimOwnershipDecisions)
        .where(eq(dbSchema.gymClaimOwnershipDecisions.claimId, lockedClaim.id))})`;
      const ownerChanged = () =>
        new GraphQLError(
          'This gym changed hands after the claim. Use Move gym ownership to hand it on from its current owner.',
          { extensions: { code: GYM_CLAIM_REVERT_CODES.ownerChanged } },
        );
      if (gym.ownerId !== lockedClaim.claimantUserId) throw ownerChanged();
      const [laterReassignment] = await tx
        .select({ id: dbSchema.gymOwnerReassignments.id })
        .from(dbSchema.gymOwnerReassignments)
        .where(
          and(
            eq(dbSchema.gymOwnerReassignments.gymUuid, gym.uuid),
            sql`${dbSchema.gymOwnerReassignments.createdAt} > ${approvedAt}`,
          ),
        )
        .limit(1);
      const [laterDecision] = await tx
        .select({ claimId: dbSchema.gymClaimOwnershipDecisions.claimId })
        .from(dbSchema.gymClaimOwnershipDecisions)
        .where(
          and(
            eq(dbSchema.gymClaimOwnershipDecisions.gymUuid, gym.uuid),
            ne(dbSchema.gymClaimOwnershipDecisions.claimId, lockedClaim.id),
            sql`${dbSchema.gymClaimOwnershipDecisions.decidedAt} > ${approvedAt}`,
          ),
        )
        .limit(1);
      if (laterReassignment || laterDecision) throw ownerChanged();

      if (decision.previousOwnerId !== SYSTEM_BOARD_OWNER_ID) {
        throw new GraphQLError(
          decision.previousOwnerId === null
            ? "There's no record of who owned this gym before the claim, so it can't go back to unclaimed. Use Move gym ownership to hand it to the right person."
            : 'This claim took the gym from someone who owned it. Use Move gym ownership to hand it back to them.',
          { extensions: { code: GYM_CLAIM_REVERT_CODES.priorOwner } },
        );
      }

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
        .where(and(eq(dbSchema.gyms.id, gym.id), eq(dbSchema.gyms.ownerId, lockedClaim.claimantUserId)))
        .returning({ syncFrozenAt: dbSchema.gyms.syncFrozenAt });
      if (moved.length !== 1) throw ownerChanged();

      // Staff from before the claim were there when it applied, so their rows
      // are older than the decision and stay.
      const removedMembers = await tx
        .delete(dbSchema.gymMembers)
        .where(
          and(
            eq(dbSchema.gymMembers.gymId, gym.id),
            or(
              eq(dbSchema.gymMembers.userId, lockedClaim.claimantUserId),
              sql`${dbSchema.gymMembers.createdAt} >= ${approvedAt}`,
            ),
          ),
        )
        .returning({ userId: dbSchema.gymMembers.userId });

      // Every approved claim, not only this one: the location sync reads any
      // approved claim on a gym as owner-curated, so an older one would keep
      // the gym out of its hands after the revert.
      await tx
        .update(dbSchema.gymClaims)
        .set({ status: 'revoked', updatedAt: sql`clock_timestamp()` })
        .where(and(eq(dbSchema.gymClaims.gymId, gym.id), eq(dbSchema.gymClaims.status, 'approved')));

      await tx.insert(dbSchema.gymOwnerReassignments).values({
        gymUuid: gym.uuid,
        previousOwnerId: lockedClaim.claimantUserId,
        newOwnerId: SYSTEM_BOARD_OWNER_ID,
        syncFrozenAtBefore: gym.syncFrozenAt,
        syncFrozenAtAfter: moved[0].syncFrozenAt,
        reason: reason ? `Claim ${lockedClaim.id} reverted: ${reason}` : `Claim ${lockedClaim.id} reverted`,
        performedBy,
        // After the gym row lock, like every other ownership event.
        createdAt: sql`clock_timestamp()`,
      });

      emailClaimantAfterCommit(tx, lockedClaim, sendGymClaimRevokedEmail);

      return {
        claim: lockedClaim,
        result: {
          claimId: String(lockedClaim.id),
          gymUuid: gym.uuid,
          gymName: gym.name,
          removedMemberCount: removedMembers.length,
        },
      };
    });

    // After the commit, so a notice that can't be written never undoes the revert.
    try {
      await sendClaimDeniedNotice(db, claim);
    } catch (error) {
      logger.warn(`[GymClaim] Claim ${claim.id} was reverted, but the in-app notice failed:`, error);
    }

    logger.info('Gym claim reverted by global admin', {
      claimId: result.claimId,
      gymUuid: result.gymUuid,
      removedMemberCount: result.removedMemberCount,
      performedBy,
    });
    return result;
  },
};
