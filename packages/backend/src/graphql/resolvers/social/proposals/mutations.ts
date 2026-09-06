import { eq, and, isNull } from 'drizzle-orm';
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

    // A hide proposal is a report by another name — it can pull a climb out of
    // everyone's browse — so it carries `reportClimb`'s safeguards whichever
    // door it came through: a reason worth reading, recorded on the proposal
    // thread where moderators look for it.
    const isHideProposal = type === 'hide';
    const hideReason = reason?.trim() ?? '';
    if (isHideProposal && hideReason.length < 10) {
      throw new Error('A reason of at least 10 characters is required for hide proposals');
    }

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
    const { proposal, comment } = await withProposalLock(climbUuid, type, async (tx) => {
      const inserted = await insertProposalWithProposerVote({
        climbUuid,
        boardType,
        angle: angle ?? null,
        type,
        proposedValue,
        currentValue,
        reason: isHideProposal ? hideReason : (reason ?? null),
        proposerId,
        executor: tx,
      });

      const reasonComment = isHideProposal
        ? await insertComment({
            userId: proposerId,
            entityType: 'proposal',
            entityId: inserted.uuid,
            body: hideReason,
            executor: tx,
          })
        : null;

      return { proposal: inserted, comment: reasonComment };
    });

    if (comment) {
      // Live comment fan-out only, exactly as `reportClimb` does: a reason is
      // not feed material, so no `comment.created` social event.
      publishCommentAddedLive('proposal', proposal.uuid, comment);
    }

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

    // Read-then-write on the voter's row, under the proposal's advisory lock:
    // two taps racing on the pool both read "no vote yet" and both insert, and
    // the unique index on (proposal_id, user_id) hands the loser an error the
    // voter sees. Serialised, the second one reads the first one's committed
    // vote and is the toggle-off a second tap has always meant.
    await withProposalLock(proposal.climbUuid, proposal.type, async (tx) => {
      // The pre-lock status check can go stale: a moderator's resolveProposal
      // (which takes this same lock) may have closed the proposal in between.
      const [live] = await tx
        .select({ status: dbSchema.climbProposals.status })
        .from(dbSchema.climbProposals)
        .where(eq(dbSchema.climbProposals.id, proposal.id))
        .limit(1);
      if (!live || live.status !== 'open') {
        throw new Error('Can only vote on open proposals');
      }

      const weight = await getUserVoteWeight(userId, proposal.boardType, tx);

      // UPSERT vote (toggle off if same value)
      const [existingVote] = await tx
        .select()
        .from(dbSchema.proposalVotes)
        .where(and(eq(dbSchema.proposalVotes.proposalId, proposal.id), eq(dbSchema.proposalVotes.userId, userId)))
        .limit(1);

      if (existingVote) {
        if (existingVote.value === value) {
          // Toggle off
          await tx.delete(dbSchema.proposalVotes).where(eq(dbSchema.proposalVotes.id, existingVote.id));
        } else {
          // Change direction
          await tx
            .update(dbSchema.proposalVotes)
            .set({ value, weight })
            .where(eq(dbSchema.proposalVotes.id, existingVote.id));
        }
      } else {
        await tx.insert(dbSchema.proposalVotes).values({ proposalId: proposal.id, userId, value, weight });
      }
    });

    // Counting the tally is a job for after the commit — see `runAutoApproval`.
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
        // One reason per reporter: a report → toggle-off → report cycle keeps
        // the vote honest but must not append a new comment every lap.
        const [existingComment] = await tx
          .select({ id: dbSchema.comments.id })
          .from(dbSchema.comments)
          .where(
            and(
              eq(dbSchema.comments.entityType, 'proposal'),
              eq(dbSchema.comments.entityId, openProposal.uuid),
              eq(dbSchema.comments.userId, reporterId),
              isNull(dbSchema.comments.deletedAt),
            ),
          )
          .limit(1);
        const comment = existingComment
          ? null
          : await insertComment({
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

    // Events describe what this call wrote, so a duplicate report announces
    // nothing: no comment fan-out, no second vote event.
    if (outcome.status !== 'already_reported') {
      // Live comment fan-out only — a report deliberately does NOT publish
      // `comment.created`, which would push every reason into the activity feed.
      if (outcome.comment) {
        publishCommentAddedLive('proposal', outcome.proposal.uuid, outcome.comment);
      }
      if (outcome.status === 'added') {
        publishProposalVoted(outcome.proposal, reporterId, 1);
      }
    }

    // Auto-approval runs on every path, `already_reported` included. A client
    // retrying after its vote committed but before approval did — a dropped
    // connection, a process restart — is precisely the case where a proposal
    // sits at threshold with nobody left to carry it over. The tally is
    // idempotent and the status flip is guarded on `status = 'open'` under the
    // proposal lock, so a duplicate report can never approve twice.
    await runAutoApproval(outcome.proposal, reporterId);

    if (outcome.status === 'created') {
      publishProposalCreated(outcome.proposal, reporterId);
    }

    return {
      status: outcome.status,
      proposal: await enrichProposal(outcome.proposal, reporterId),
    };
  },

  resolveProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    // Authentication first: an anonymous caller learns nothing about which
    // proposal UUIDs exist or what state they are in. The role check needs the
    // proposal's board type, so it stays below the load.
    requireAuthenticated(ctx);

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

    const resolvedAt = new Date();

    // The status flip and the effect land together. Split across two statements,
    // a failure in between leaves an 'approved' row describing a climb that was
    // never changed — the same hazard `deleteProposal` closes on the way back.
    // Under the proposal's advisory lock, with the UPDATE guarded on
    // `status = 'open'`: an auto-approval that commits between the check above
    // and this write must not be overwritten with a moderator's 'rejected' (the
    // climb would stay hidden with no approved proposal explaining it).
    await withProposalLock(proposal.climbUuid, proposal.type, async (tx) => {
      const [transitioned] = await tx
        .update(dbSchema.climbProposals)
        .set({
          status: status as ProposalStatus,
          resolvedAt,
          resolvedBy: userId,
          reason: reason || proposal.reason,
        })
        .where(and(eq(dbSchema.climbProposals.id, proposal.id), eq(dbSchema.climbProposals.status, 'open')))
        .returning({ id: dbSchema.climbProposals.id });
      if (!transitioned) {
        throw new Error('Proposal is no longer open');
      }

      if (status === 'approved') {
        await applyProposalEffect(proposal, tx);
      }
    });

    proposal.status = status as ProposalRow['status'];
    proposal.resolvedAt = resolvedAt;
    proposal.resolvedBy = userId;

    if (status === 'approved') {
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
    // Same order as `resolveProposal`: authenticate before anything reads the
    // proposal, then check the role once the board type is known.
    requireAuthenticated(ctx);

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
    // Same per-climb advisory lock as create / vote / report / resolve, so a
    // revert cannot interleave with an approval of a sibling proposal.
    await withProposalLock(proposal.climbUuid, proposal.type, async (tx) => {
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
