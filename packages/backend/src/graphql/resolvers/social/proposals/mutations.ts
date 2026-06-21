import { eq, and, sql, isNull } from 'drizzle-orm';
import type { ConnectionContext, ProposalStatus } from '@boardsesh/shared-schema';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import { requireAuthenticated, applyRateLimit, validateInput } from '../../shared/helpers';
import {
  CreateProposalInputSchema,
  VoteOnProposalInputSchema,
  ResolveProposalInputSchema,
  DeleteProposalInputSchema,
} from '../../../../validation/schemas';
import { logger } from '../../../../utils/logger';
import { publishSocialEvent } from '../../../../events/index';
import { notifyClimbRevalidated } from '../../../../lib/web-revalidate';
import { requireAdminOrLeader, getUserVoteWeight } from '../roles';
import { resolveCommunitySetting } from '../community-settings';
import crypto from 'crypto';
import { enrichProposal } from './enrichment';
import { applyProposalEffect, revertProposalEffect } from './effects';
import { checkAutoApproval } from './grade-analysis';
import { setterOverrideCommunityStatus, freezeClimb } from './setter-overrides';

export const socialProposalMutations = {
  createProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'createProposal');

    const validated = validateInput(CreateProposalInputSchema, input, 'input');
    const { climbUuid, boardType, angle, type, proposedValue, reason } = validated;
    const proposerId = ctx.userId!;

    // Validate: angle required for grade/benchmark, null for classic
    if ((type === 'grade' || type === 'benchmark') && angle == null) {
      throw new Error('Angle is required for grade and benchmark proposals');
    }
    if (type === 'classic' && angle != null) {
      throw new Error('Angle must not be set for classic proposals');
    }

    // Check not frozen
    const frozenSetting = await resolveCommunitySetting('climb_frozen', climbUuid, angle, boardType);
    if (frozenSetting === 'true') {
      throw new Error('This climb is frozen and cannot receive new proposals');
    }

    // Resolve current value
    let currentValue = '';
    if (type === 'grade') {
      // Try community status first, then board climb stats
      const [communityStatus] = await db
        .select({ communityGrade: dbSchema.climbCommunityStatus.communityGrade })
        .from(dbSchema.climbCommunityStatus)
        .where(
          and(
            eq(dbSchema.climbCommunityStatus.climbUuid, climbUuid),
            eq(dbSchema.climbCommunityStatus.boardType, boardType),
            eq(dbSchema.climbCommunityStatus.angle, angle!),
          ),
        )
        .limit(1);

      if (communityStatus?.communityGrade) {
        currentValue = communityStatus.communityGrade;
      } else {
        try {
          // Look up display_difficulty from stats, then resolve grade name in-memory
          const rows = await executeRows<{ difficulty_id: number | null }>(
            db,
            sql`
            SELECT ROUND(cs.display_difficulty::numeric, 0) as difficulty_id
            FROM board_climb_stats cs
            WHERE cs.climb_uuid = ${climbUuid}
              AND cs.angle = ${angle}
              AND cs.board_type = ${boardType}
            LIMIT 1
          `,
          );
          currentValue = getGradeLabel(rows[0]?.difficulty_id ?? null) || 'Unknown';
        } catch {
          currentValue = 'Unknown';
        }
      }

      // Prevent proposals to the same grade
      if (currentValue === proposedValue) {
        throw new Error('Proposed grade is the same as the current grade');
      }
    } else if (type === 'benchmark') {
      const [communityStatus] = await db
        .select({ isBenchmark: dbSchema.climbCommunityStatus.isBenchmark })
        .from(dbSchema.climbCommunityStatus)
        .where(
          and(
            eq(dbSchema.climbCommunityStatus.climbUuid, climbUuid),
            eq(dbSchema.climbCommunityStatus.boardType, boardType),
            eq(dbSchema.climbCommunityStatus.angle, angle!),
          ),
        )
        .limit(1);
      currentValue = String(communityStatus?.isBenchmark || false);
    } else if (type === 'classic') {
      const [classicStatus] = await db
        .select({ isClassic: dbSchema.climbClassicStatus.isClassic })
        .from(dbSchema.climbClassicStatus)
        .where(
          and(
            eq(dbSchema.climbClassicStatus.climbUuid, climbUuid),
            eq(dbSchema.climbClassicStatus.boardType, boardType),
          ),
        )
        .limit(1);
      currentValue = String(classicStatus?.isClassic || false);
    }

    // Supersede existing open proposals of same (climbUuid, angle, type)
    const supersedeConditions = [
      eq(dbSchema.climbProposals.climbUuid, climbUuid),
      eq(dbSchema.climbProposals.boardType, boardType),
      eq(dbSchema.climbProposals.type, type),
      eq(dbSchema.climbProposals.status, 'open'),
    ];
    if (angle != null) supersedeConditions.push(eq(dbSchema.climbProposals.angle, angle));
    else supersedeConditions.push(isNull(dbSchema.climbProposals.angle));

    await db
      .update(dbSchema.climbProposals)
      .set({ status: 'superseded', resolvedAt: new Date() })
      .where(and(...supersedeConditions));

    // Insert proposal
    const uuid = crypto.randomUUID();
    const [proposal] = await db
      .insert(dbSchema.climbProposals)
      .values({
        uuid,
        climbUuid,
        boardType,
        angle: angle ?? null,
        proposerId,
        type,
        proposedValue,
        currentValue,
        reason: reason || null,
      })
      .returning();

    // Auto-vote with proposer's weight
    const weight = await getUserVoteWeight(proposerId, boardType);
    await db.insert(dbSchema.proposalVotes).values({
      proposalId: proposal.id,
      userId: proposerId,
      value: 1,
      weight,
    });

    // Check auto-approval (atomic: only transition if still 'open')
    const shouldApprove = await checkAutoApproval(proposal.id, boardType, climbUuid, angle ?? null);
    if (shouldApprove) {
      const [approved] = await db
        .update(dbSchema.climbProposals)
        .set({ status: 'approved', resolvedAt: new Date() })
        .where(and(eq(dbSchema.climbProposals.id, proposal.id), eq(dbSchema.climbProposals.status, 'open')))
        .returning();

      if (approved) {
        proposal.status = 'approved';
        proposal.resolvedAt = approved.resolvedAt;

        await applyProposalEffect(proposal);
        void notifyClimbRevalidated(climbUuid);

        publishSocialEvent({
          type: 'proposal.approved',
          actorId: proposerId,
          entityType: 'proposal',
          entityId: uuid,
          timestamp: Date.now(),
          metadata: { climbUuid, boardType, proposalType: type },
        }).catch((err) => logger.error('[Proposals] Failed to publish proposal.approved:', err));
      }
    }

    // Publish created event
    publishSocialEvent({
      type: 'proposal.created',
      actorId: proposerId,
      entityType: 'proposal',
      entityId: uuid,
      timestamp: Date.now(),
      metadata: { climbUuid, boardType, proposalType: type },
    }).catch((err) => logger.error('[Proposals] Failed to publish proposal.created:', err));

    return enrichProposal(proposal, proposerId);
  },

  voteOnProposal: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'voteOnProposal');

    const validated = validateInput(VoteOnProposalInputSchema, input, 'input');
    const { proposalUuid, value } = validated;
    const userId = ctx.userId!;

    // Find proposal
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

    // Compute voter's weight
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

    // Check auto-approval (atomic: only transition if still 'open')
    const shouldApprove = await checkAutoApproval(proposal.id, proposal.boardType, proposal.climbUuid, proposal.angle);
    if (shouldApprove) {
      const [approved] = await db
        .update(dbSchema.climbProposals)
        .set({ status: 'approved', resolvedAt: new Date() })
        .where(and(eq(dbSchema.climbProposals.id, proposal.id), eq(dbSchema.climbProposals.status, 'open')))
        .returning();

      if (approved) {
        proposal.status = 'approved';
        proposal.resolvedAt = approved.resolvedAt;

        await applyProposalEffect(proposal);
        void notifyClimbRevalidated(proposal.climbUuid);

        publishSocialEvent({
          type: 'proposal.approved',
          actorId: userId,
          entityType: 'proposal',
          entityId: proposalUuid,
          timestamp: Date.now(),
          metadata: {
            climbUuid: proposal.climbUuid,
            boardType: proposal.boardType,
            proposalType: proposal.type,
          },
        }).catch((err) => logger.error('[Proposals] Failed to publish proposal.approved:', err));
      }
    }

    // Publish voted event
    publishSocialEvent({
      type: 'proposal.voted',
      actorId: userId,
      entityType: 'proposal',
      entityId: proposalUuid,
      timestamp: Date.now(),
      metadata: {
        value: String(value),
        climbUuid: proposal.climbUuid,
        boardType: proposal.boardType,
      },
    }).catch((err) => logger.error('[Proposals] Failed to publish proposal.voted:', err));

    return enrichProposal(proposal, userId);
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

    proposal.status = status as typeof proposal.status;
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
    await revertProposalEffect(proposal);
    void notifyClimbRevalidated(proposal.climbUuid);

    // Hard-delete the proposal (votes cascade-delete via FK, lastProposalId set to null via FK)
    await db.delete(dbSchema.climbProposals).where(eq(dbSchema.climbProposals.id, proposal.id));

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
