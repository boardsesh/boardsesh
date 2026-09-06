import { eq, and, sql, desc, isNull } from 'drizzle-orm';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { ProposalExecutor } from './lifecycle';

/**
 * Apply the effect of an approved proposal to the climb community/classic status.
 */
export async function applyProposalEffect(proposal: typeof dbSchema.climbProposals.$inferSelect): Promise<void> {
  if (proposal.type === 'grade' || proposal.type === 'benchmark') {
    // UPSERT climb_community_status
    const [existing] = await db
      .select()
      .from(dbSchema.climbCommunityStatus)
      .where(
        and(
          eq(dbSchema.climbCommunityStatus.climbUuid, proposal.climbUuid),
          eq(dbSchema.climbCommunityStatus.boardType, proposal.boardType),
          eq(dbSchema.climbCommunityStatus.angle, proposal.angle!),
        ),
      )
      .limit(1);

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      lastProposalId: proposal.id,
    };

    if (proposal.type === 'grade') {
      updates.communityGrade = proposal.proposedValue;
    } else if (proposal.type === 'benchmark') {
      updates.isBenchmark = proposal.proposedValue === 'true';
    }

    if (existing) {
      await db
        .update(dbSchema.climbCommunityStatus)
        .set(updates)
        .where(eq(dbSchema.climbCommunityStatus.id, existing.id));
    } else {
      await db.insert(dbSchema.climbCommunityStatus).values({
        climbUuid: proposal.climbUuid,
        boardType: proposal.boardType,
        angle: proposal.angle!,
        communityGrade: proposal.type === 'grade' ? proposal.proposedValue : null,
        isBenchmark: proposal.type === 'benchmark' ? proposal.proposedValue === 'true' : false,
        lastProposalId: proposal.id,
      });
    }
  } else if (proposal.type === 'hide') {
    // The hidden flag lives on the climb row itself — hidden climbs drop out of
    // browse and search but stay openable by direct link. `updated_at`/`sync_seq`
    // are bumped by a BEFORE UPDATE trigger, so don't set them here.
    const shouldHide = proposal.proposedValue === 'true';
    await db
      .update(dbSchema.boardClimbs)
      .set({ isHidden: shouldHide, hiddenAt: shouldHide ? new Date() : null })
      .where(
        and(eq(dbSchema.boardClimbs.uuid, proposal.climbUuid), eq(dbSchema.boardClimbs.boardType, proposal.boardType)),
      );
  } else if (proposal.type === 'classic') {
    // UPSERT climb_classic_status
    const [existing] = await db
      .select()
      .from(dbSchema.climbClassicStatus)
      .where(
        and(
          eq(dbSchema.climbClassicStatus.climbUuid, proposal.climbUuid),
          eq(dbSchema.climbClassicStatus.boardType, proposal.boardType),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(dbSchema.climbClassicStatus)
        .set({
          isClassic: proposal.proposedValue === 'true',
          updatedAt: new Date(),
          lastProposalId: proposal.id,
        })
        .where(eq(dbSchema.climbClassicStatus.id, existing.id));
    } else {
      await db.insert(dbSchema.climbClassicStatus).values({
        climbUuid: proposal.climbUuid,
        boardType: proposal.boardType,
        isClassic: proposal.proposedValue === 'true',
        lastProposalId: proposal.id,
      });
    }
  }
}

/**
 * Revert the effect of a previously-approved proposal.
 * Finds the most recent OTHER approved proposal of the same type for the same climb+angle
 * and reverts to that value (or to the default if none exists).
 */
export async function revertProposalEffect(
  proposal: typeof dbSchema.climbProposals.$inferSelect,
  executor: ProposalExecutor = db,
): Promise<void> {
  if (proposal.type === 'grade' || proposal.type === 'benchmark') {
    // Find the most recent other approved proposal of the same type for this climb+angle
    const conditions = [
      eq(dbSchema.climbProposals.climbUuid, proposal.climbUuid),
      eq(dbSchema.climbProposals.boardType, proposal.boardType),
      eq(dbSchema.climbProposals.type, proposal.type),
      eq(dbSchema.climbProposals.status, 'approved'),
      sql`${dbSchema.climbProposals.id} != ${proposal.id}`,
    ];
    if (proposal.angle != null) {
      conditions.push(eq(dbSchema.climbProposals.angle, proposal.angle));
    }

    const [previousProposal] = await executor
      .select()
      .from(dbSchema.climbProposals)
      .where(and(...conditions))
      .orderBy(desc(dbSchema.climbProposals.resolvedAt))
      .limit(1);

    const [existing] = await executor
      .select()
      .from(dbSchema.climbCommunityStatus)
      .where(
        and(
          eq(dbSchema.climbCommunityStatus.climbUuid, proposal.climbUuid),
          eq(dbSchema.climbCommunityStatus.boardType, proposal.boardType),
          eq(dbSchema.climbCommunityStatus.angle, proposal.angle!),
        ),
      )
      .limit(1);

    if (existing) {
      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
        lastProposalId: previousProposal?.id || null,
      };

      if (proposal.type === 'grade') {
        updates.communityGrade = previousProposal?.proposedValue || null;
      } else if (proposal.type === 'benchmark') {
        updates.isBenchmark = previousProposal ? previousProposal.proposedValue === 'true' : false;
      }

      await executor
        .update(dbSchema.climbCommunityStatus)
        .set(updates)
        .where(eq(dbSchema.climbCommunityStatus.id, existing.id));
    }
  } else if (proposal.type === 'hide') {
    // Fall back to whatever the previous approved hide decision said; with none,
    // the climb goes back to visible. Hide proposals are climb-wide, so they
    // always carry a null angle.
    const [previousProposal] = await executor
      .select()
      .from(dbSchema.climbProposals)
      .where(
        and(
          eq(dbSchema.climbProposals.climbUuid, proposal.climbUuid),
          eq(dbSchema.climbProposals.boardType, proposal.boardType),
          eq(dbSchema.climbProposals.type, 'hide'),
          eq(dbSchema.climbProposals.status, 'approved'),
          isNull(dbSchema.climbProposals.angle),
          sql`${dbSchema.climbProposals.id} != ${proposal.id}`,
        ),
      )
      // NULLS LAST, explicitly: Postgres sorts NULL first under DESC, so an
      // approved row that predates `resolved_at` being written would outrank
      // every dated decision and decide the climb's visibility on its own.
      .orderBy(sql`${dbSchema.climbProposals.resolvedAt} DESC NULLS LAST`)
      .limit(1);

    const shouldHide = previousProposal ? previousProposal.proposedValue === 'true' : false;
    await executor
      .update(dbSchema.boardClimbs)
      .set({
        isHidden: shouldHide,
        hiddenAt: shouldHide ? (previousProposal?.resolvedAt ?? new Date()) : null,
      })
      .where(
        and(eq(dbSchema.boardClimbs.uuid, proposal.climbUuid), eq(dbSchema.boardClimbs.boardType, proposal.boardType)),
      );
  } else if (proposal.type === 'classic') {
    // Find the most recent other approved classic proposal for this climb
    const [previousProposal] = await executor
      .select()
      .from(dbSchema.climbProposals)
      .where(
        and(
          eq(dbSchema.climbProposals.climbUuid, proposal.climbUuid),
          eq(dbSchema.climbProposals.boardType, proposal.boardType),
          eq(dbSchema.climbProposals.type, 'classic'),
          eq(dbSchema.climbProposals.status, 'approved'),
          sql`${dbSchema.climbProposals.id} != ${proposal.id}`,
        ),
      )
      .orderBy(desc(dbSchema.climbProposals.resolvedAt))
      .limit(1);

    const [existing] = await executor
      .select()
      .from(dbSchema.climbClassicStatus)
      .where(
        and(
          eq(dbSchema.climbClassicStatus.climbUuid, proposal.climbUuid),
          eq(dbSchema.climbClassicStatus.boardType, proposal.boardType),
        ),
      )
      .limit(1);

    if (existing) {
      const classicUpdates: Record<string, unknown> = {
        isClassic: previousProposal ? previousProposal.proposedValue === 'true' : false,
        updatedAt: new Date(),
        lastProposalId: previousProposal?.id || null,
      };
      await executor
        .update(dbSchema.climbClassicStatus)
        .set(classicUpdates)
        .where(eq(dbSchema.climbClassicStatus.id, existing.id));
    }
  }
}
