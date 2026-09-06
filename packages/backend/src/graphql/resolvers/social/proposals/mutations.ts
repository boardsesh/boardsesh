import { eq, and } from 'drizzle-orm';
import type { ConnectionContext, ProposalStatus } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../../shared/helpers';
import {
  CreateProposalInputSchema,
  VoteOnProposalInputSchema,
  ResolveProposalInputSchema,
  DeleteProposalInputSchema,
  ReportClimbInputSchema,
} from '../../../../validation/schemas';
import { logger } from '../../../../utils/logger';
import { publishSocialEvent } from '../../../../events/index';
import { notifyClimbRevalidated } from '../../../../lib/web-revalidate';
import { requireAdminOrLeader, getUserVoteWeight } from '../roles';
import { insertComment, publishCommentAddedLive } from '../comments';
import { enrichProposal } from './enrichment';
import { applyProposalEffect, revertProposalEffect } from './effects';
import { setterOverrideCommunityStatus, freezeClimb } from './setter-overrides';
import {
  addWeightedUpvote,
  assertAngleForType,
  assertNotFrozen,
  findOpenProposal,
  flipVoteToUpvote,
  insertProposalWithProposerVote,
  loadTargetClimb,
  normalizeAngleForType,
  publishProposalCreated,
  publishProposalVoted,
  resolveCurrentValue,
  runAutoApproval,
  withProposalLock,
  type ProposalRow,
} from './lifecycle';

export const socialProposalMutations = {
  createProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'createProposal');

    const validated = validateInput(CreateProposalInputSchema, input, 'input');
    const { climbUuid, boardType, angle, type, proposedValue, reason } = validated;
    const proposerId = ctx.userId!;

    assertAngleForType(type, angle);
    const target = await loadTargetClimb(climbUuid, boardType);
    await assertNotFrozen(climbUuid, angle ?? null, boardType);

    const currentValue = await resolveCurrentValue({
      type,
      climbUuid,
      boardType,
      angle: angle ?? null,
      proposedValue,
      target,
    });

    // Supersede + insert + proposer vote share one advisory lock so two people
    // proposing the same change at once can't end up with two open rows.
    const proposal = await withProposalLock(climbUuid, type, (tx) =>
      insertProposalWithProposerVote({
        climbUuid,
        boardType,
        angle: angle ?? null,
        type,
        proposedValue,
        currentValue,
        reason: reason ?? null,
        proposerId,
        executor: tx,
      }),
    );

    await runAutoApproval(proposal, proposerId);
    publishProposalCreated(proposal, proposerId);

    return enrichProposal(proposal, proposerId);
  },

  voteOnProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'voteOnProposal');

    const validated = validateInput(VoteOnProposalInputSchema, input, 'input');
    const { proposalUuid, value } = validated;
    const userId = ctx.userId!;

    const [proposal] = await db
      .select()
      .from(dbSchema.climbProposals)
      .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
      .limit(1);

    if (!proposal) {
      throw new Error('Proposal not found');
    }
    if (proposal.status !== 'open') {
      throw new Error('Can only vote on open proposals');
    }

    const weight = await getUserVoteWeight(userId, proposal.boardType);

    // UPSERT vote (toggle off if same value)
    const [existingVote] = await db
      .select()
      .from(dbSchema.proposalVotes)
      .where(and(eq(dbSchema.proposalVotes.proposalId, proposal.id), eq(dbSchema.proposalVotes.userId, userId)))
      .limit(1);

    if (existingVote) {
      if (existingVote.value === value) {
        // Toggle off
        await db.delete(dbSchema.proposalVotes).where(eq(dbSchema.proposalVotes.id, existingVote.id));
      } else {
        // Change direction
        await db
          .update(dbSchema.proposalVotes)
          .set({ value, weight })
          .where(eq(dbSchema.proposalVotes.id, existingVote.id));
      }
    } else {
      await db.insert(dbSchema.proposalVotes).values({ proposalId: proposal.id, userId, value, weight });
    }

    await runAutoApproval(proposal, userId);
    publishProposalVoted(proposal, userId, value);

    return enrichProposal(proposal, userId);
  },

  /**
   * Report a climb: ask for it to be hidden, or for its grade to be corrected.
   *
   * A report is a proposal plus a comment carrying the reporter's reason. The
   * first reporter opens the proposal; everyone after them joins it, so the
   * weight of a complaint is visible in one place instead of scattered across
   * near-identical rows. Reporting twice is a no-op rather than an error — the
   * client can retry without inflating the tally.
   */
  reportClimb: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'reportClimb');

    const validated = validateInput(ReportClimbInputSchema, input, 'input');
    const { climbUuid, boardType, kind, proposedGrade, reason } = validated;
    const reporterId = ctx.userId!;

    const type = kind === 'hide' ? 'hide' : 'grade';
    const angle = normalizeAngleForType(type, validated.angle);
    // The schema guarantees a grade label on the grade path.
    const proposedValue = kind === 'hide' ? 'true' : proposedGrade!;

    const target = await loadTargetClimb(climbUuid, boardType);
    await assertNotFrozen(climbUuid, angle, boardType);

    const outcome = await withProposalLock(climbUuid, type, async (tx) => {
      const openProposal = await findOpenProposal({ climbUuid, boardType, type, angle, proposedValue, executor: tx });

      if (openProposal) {
        const [priorVote] = await tx
          .select({ id: dbSchema.proposalVotes.id, value: dbSchema.proposalVotes.value })
          .from(dbSchema.proposalVotes)
          .where(
            and(eq(dbSchema.proposalVotes.proposalId, openProposal.id), eq(dbSchema.proposalVotes.userId, reporterId)),
          )
          .limit(1);

        // Only a standing +1 is a duplicate report. A -1 is the opposite
        // position: someone who voted the hide down and has now hit report has
        // changed their mind, so the vote flips (at their current weight) and
        // the report lands with its reason, rather than being swallowed as
        // "already reported" while their downvote keeps holding the tally down.
        if (priorVote?.value === 1) {
          return { status: 'already_reported' as const, proposal: openProposal, comment: null };
        }

        if (priorVote) {
          await flipVoteToUpvote(openProposal, priorVote.id, reporterId, tx);
        } else {
          await addWeightedUpvote(openProposal, reporterId, tx);
        }
        const comment = await insertComment({
          userId: reporterId,
          entityType: 'proposal',
          entityId: openProposal.uuid,
          body: reason,
          executor: tx,
        });
        return { status: 'added' as const, proposal: openProposal, comment };
      }

      const currentValue = await resolveCurrentValue({
        type,
        climbUuid,
        boardType,
        angle,
        proposedValue,
        target,
        executor: tx,
      });

      const created = await insertProposalWithProposerVote({
        climbUuid,
        boardType,
        angle,
        type,
        proposedValue,
        currentValue,
        reason,
        proposerId: reporterId,
        executor: tx,
      });

      const comment = await insertComment({
        userId: reporterId,
        entityType: 'proposal',
        entityId: created.uuid,
        body: reason,
        executor: tx,
      });
      return { status: 'created' as const, proposal: created, comment };
    });

    if (outcome.status !== 'already_reported') {
      // Live comment fan-out only — a report deliberately does NOT publish
      // `comment.created`, which would push every reason into the activity feed.
      publishCommentAddedLive('proposal', outcome.proposal.uuid, outcome.comment);
      if (outcome.status === 'added') {
        publishProposalVoted(outcome.proposal, reporterId, 1);
      }
      await runAutoApproval(outcome.proposal, reporterId);
      if (outcome.status === 'created') {
        publishProposalCreated(outcome.proposal, reporterId);
      }
    }

    return {
      status: outcome.status,
      proposal: await enrichProposal(outcome.proposal, reporterId),
    };
  },

  resolveProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validated = validateInput(ResolveProposalInputSchema, input, 'input');
    const { proposalUuid, status, reason } = validated;

    // Find proposal
    const [proposal] = await db
      .select()
      .from(dbSchema.climbProposals)
      .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
      .limit(1);

    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'open') throw new Error('Can only resolve open proposals');

    await requireAdminOrLeader(ctx, proposal.boardType);
    const userId = ctx.userId!;

    // Update proposal
    await db
      .update(dbSchema.climbProposals)
      .set({
        status: status as ProposalStatus,
        resolvedAt: new Date(),
        resolvedBy: userId,
        reason: reason || proposal.reason,
      })
      .where(eq(dbSchema.climbProposals.id, proposal.id));

    proposal.status = status as ProposalRow['status'];
    proposal.resolvedAt = new Date();
    proposal.resolvedBy = userId;

    if (status === 'approved') {
      await applyProposalEffect(proposal);
      void notifyClimbRevalidated(proposal.climbUuid);
    }

    const eventType = status === 'approved' ? 'proposal.approved' : 'proposal.rejected';
    publishSocialEvent({
      type: eventType,
      actorId: userId,
      entityType: 'proposal',
      entityId: proposalUuid,
      timestamp: Date.now(),
      metadata: {
        climbUuid: proposal.climbUuid,
        boardType: proposal.boardType,
        proposalType: proposal.type,
      },
    }).catch((err) => logger.error(`[Proposals] Failed to publish ${eventType}:`, err));

    return enrichProposal(proposal, userId);
  },

  deleteProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validated = validateInput(DeleteProposalInputSchema, input, 'input');
    const { proposalUuid } = validated;

    // Find proposal
    const [proposal] = await db
      .select()
      .from(dbSchema.climbProposals)
      .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
      .limit(1);

    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'approved') throw new Error('Can only delete approved proposals');

    await requireAdminOrLeader(ctx, proposal.boardType);
    const userId = ctx.userId!;

    // Revert the proposal's effect
    // Revert and delete in one transaction: a failed delete after a successful
    // revert would leave an 'approved' row describing state the climb no longer has.
    await db.transaction(async (tx) => {
      await revertProposalEffect(proposal, tx);
      // Hard-delete the proposal (votes cascade-delete via FK, lastProposalId set to null via FK)
      await tx.delete(dbSchema.climbProposals).where(eq(dbSchema.climbProposals.id, proposal.id));
    });
    void notifyClimbRevalidated(proposal.climbUuid);

    // Publish deleted event
    publishSocialEvent({
      type: 'proposal.deleted',
      actorId: userId,
      entityType: 'proposal',
      entityId: proposalUuid,
      timestamp: Date.now(),
      metadata: {
        climbUuid: proposal.climbUuid,
        boardType: proposal.boardType,
        proposalType: proposal.type,
      },
    }).catch((err) => logger.error('[Proposals] Failed to publish proposal.deleted:', err));

    return true;
  },

  setterOverrideCommunityStatus,

  freezeClimb,
};
