import { eq, and, sql, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import { logger } from '../../../../utils/logger';
import { publishSocialEvent } from '../../../../events/index';
import { notifyClimbRevalidated } from '../../../../lib/web-revalidate';
import { getUserVoteWeight } from '../roles';
import { resolveCommunitySetting } from '../community-settings';
import { applyProposalEffect } from './effects';
import { checkAutoApproval } from './grade-analysis';
import { assertClimbBoardType } from './climb-board-type';
import crypto from 'crypto';

/**
 * Proposal lifecycle helpers.
 *
 * `createProposal`, `voteOnProposal` and `reportClimb` all walk the same path —
 * validate the angle against the proposal type, load the climb, refuse a frozen
 * one, work out what the value is today, write the proposal plus the proposer's
 * weighted vote, then see whether that vote already carries it over the approval
 * threshold. Keeping the steps here means the report flow reuses the exact rules
 * the proposal flow has always applied instead of a second, drifting copy.
 */

/**
 * Anything that can run drizzle queries: the backend's `db` singleton, or the
 * `tx` handed to a `db.transaction(...)` callback. Threading it through lets the
 * find-then-insert critical section run on one connection inside the advisory
 * lock and still see its own pending writes.
 */
export type ProposalExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type ProposalRow = typeof dbSchema.climbProposals.$inferSelect;

export type ProposalTypeName = ProposalRow['type'];

/**
 * The climb a proposal targets, reduced to what the lifecycle needs: the stored
 * board type (to fence client-declared scope), whether the community has hidden
 * it, and who owns/set it.
 */
export type TargetClimb = {
  boardType: string;
  isHidden: boolean;
  userId: string | null;
  setterId: number | null;
};

/**
 * Namespace for the proposal advisory lock, keeping it clear of the
 * climb-duplicate gate's namespace (`0x434c4942`). Spells "PROP".
 */
const PROPOSAL_LOCK_NAMESPACE = 0x50524f50;

/**
 * Angle scope per proposal type. Grade and benchmark are per-angle facts, so an
 * angle is mandatory. Classic and hide describe the climb as a whole, so an
 * angle would silently split one decision across angle-keyed rows.
 */
export function assertAngleForType(type: ProposalTypeName, angle: number | null | undefined): void {
  if ((type === 'grade' || type === 'benchmark') && angle == null) {
    throw new Error('Angle is required for grade and benchmark proposals');
  }
  if (type === 'classic' && angle != null) {
    throw new Error('Angle must not be set for classic proposals');
  }
  if (type === 'hide' && angle != null) {
    throw new Error('Angle must not be set for hide proposals');
  }
}

/**
 * The angle a proposal of this type is stored with. Climb-wide types (classic,
 * hide) always store null — `reportClimb` accepts an angle from clients that
 * send their current view and drops it here rather than rejecting the report.
 */
export function normalizeAngleForType(type: ProposalTypeName, angle: number | null | undefined): number | null {
  if (type === 'classic' || type === 'hide') return null;
  return angle ?? null;
}

/**
 * Load the proposal's target climb and fence the client-declared board type.
 *
 * `boardType` is client input while climb UUIDs are globally unique, so the pair
 * has to be checked against the stored climb before it is used as a proposal key
 * — proposal rows have no FK back to `board_climbs`, so a Kilter UUID declared
 * as Grasshopper would otherwise smuggle -5° into them.
 */
export async function loadTargetClimb(
  climbUuid: string,
  boardType: string,
  executor: ProposalExecutor = db,
): Promise<TargetClimb> {
  const [climb] = await executor
    .select({
      boardType: dbSchema.boardClimbs.boardType,
      isHidden: dbSchema.boardClimbs.isHidden,
      userId: dbSchema.boardClimbs.userId,
      setterId: dbSchema.boardClimbs.setterId,
    })
    .from(dbSchema.boardClimbs)
    .where(eq(dbSchema.boardClimbs.uuid, climbUuid))
    .limit(1);

  if (!climb) {
    throw new Error('Climb not found');
  }
  assertClimbBoardType(climb.boardType, boardType);

  return climb;
}

/** Refuse new proposals on a climb an admin has frozen. */
export async function assertNotFrozen(climbUuid: string, angle: number | null, boardType: string): Promise<void> {
  const frozenSetting = await resolveCommunitySetting('climb_frozen', climbUuid, angle, boardType);
  if (frozenSetting === 'true') {
    throw new Error('This climb is frozen and cannot receive new proposals');
  }
}

/**
 * What the proposal is asking to change, as it stands today. Stored on the
 * proposal so the vote UI can show "6b+/V4 → 6c/V5" without re-deriving a value
 * that may have moved since.
 *
 * Also the place the no-op guards live: proposing the grade a climb already has,
 * hiding a hidden climb, or unhiding a visible one are all rejected here.
 */
export async function resolveCurrentValue(params: {
  type: ProposalTypeName;
  climbUuid: string;
  boardType: string;
  angle: number | null;
  proposedValue: string;
  target: TargetClimb;
  executor?: ProposalExecutor;
}): Promise<string> {
  const { type, climbUuid, boardType, angle, proposedValue, target, executor = db } = params;

  if (type === 'grade') {
    // Community grade wins when one exists; otherwise fall back to the board's
    // own display difficulty.
    const [communityStatus] = await executor
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

    let currentValue: string;
    if (communityStatus?.communityGrade) {
      currentValue = communityStatus.communityGrade;
    } else {
      try {
        // Look up display_difficulty from stats, then resolve grade name in-memory
        const statsRows = await executeRows<{ difficulty_id: number | null }>(
          executor,
          sql`
            SELECT ROUND(cs.display_difficulty::numeric, 0) as difficulty_id
            FROM board_climb_stats cs
            WHERE cs.climb_uuid = ${climbUuid}
              AND cs.angle = ${angle}
              AND cs.board_type = ${boardType}
            LIMIT 1
          `,
        );
        currentValue = getGradeLabel(statsRows[0]?.difficulty_id ?? null) || 'Unknown';
      } catch {
        currentValue = 'Unknown';
      }
    }

    if (currentValue === proposedValue) {
      throw new Error('Proposed grade is the same as the current grade');
    }
    return currentValue;
  }

  if (type === 'benchmark') {
    const [communityStatus] = await executor
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
    return String(communityStatus?.isBenchmark || false);
  }

  if (type === 'classic') {
    const [classicStatus] = await executor
      .select({ isClassic: dbSchema.climbClassicStatus.isClassic })
      .from(dbSchema.climbClassicStatus)
      .where(
        and(eq(dbSchema.climbClassicStatus.climbUuid, climbUuid), eq(dbSchema.climbClassicStatus.boardType, boardType)),
      )
      .limit(1);
    return String(classicStatus?.isClassic || false);
  }

  // hide — the live flag lives on the climb row itself.
  if (target.isHidden && proposedValue === 'true') {
    throw new Error('Climb is already hidden');
  }
  if (!target.isHidden && proposedValue === 'false') {
    throw new Error('Climb is not hidden');
  }
  return String(target.isHidden);
}

/**
 * The open proposal a new report should join, if there is one: same climb, same
 * board, same type, same angle, asking for the same value.
 */
export async function findOpenProposal(params: {
  climbUuid: string;
  boardType: string;
  type: ProposalTypeName;
  angle: number | null;
  proposedValue: string;
  executor?: ProposalExecutor;
}): Promise<ProposalRow | null> {
  const { climbUuid, boardType, type, angle, proposedValue, executor = db } = params;

  const conditions = [
    eq(dbSchema.climbProposals.climbUuid, climbUuid),
    eq(dbSchema.climbProposals.boardType, boardType),
    eq(dbSchema.climbProposals.type, type),
    eq(dbSchema.climbProposals.status, 'open'),
    eq(dbSchema.climbProposals.proposedValue, proposedValue),
    angle != null ? eq(dbSchema.climbProposals.angle, angle) : isNull(dbSchema.climbProposals.angle),
  ];

  const [proposal] = await executor
    .select()
    .from(dbSchema.climbProposals)
    .where(and(...conditions))
    .limit(1);

  return proposal ?? null;
}

/**
 * Open a proposal and record the proposer's own weighted upvote.
 *
 * Any other open proposal on the same (climb, board, angle, type) is superseded
 * first — whatever value it asked for. One open question per facet at a time,
 * otherwise votes split across rival proposals and neither reaches the
 * threshold.
 */
export async function insertProposalWithProposerVote(params: {
  climbUuid: string;
  boardType: string;
  angle: number | null;
  type: ProposalTypeName;
  proposedValue: string;
  currentValue: string;
  reason: string | null;
  proposerId: string;
  executor?: ProposalExecutor;
}): Promise<ProposalRow> {
  const { climbUuid, boardType, angle, type, proposedValue, currentValue, reason, proposerId, executor = db } = params;

  const supersedeConditions = [
    eq(dbSchema.climbProposals.climbUuid, climbUuid),
    eq(dbSchema.climbProposals.boardType, boardType),
    eq(dbSchema.climbProposals.type, type),
    eq(dbSchema.climbProposals.status, 'open'),
    angle != null ? eq(dbSchema.climbProposals.angle, angle) : isNull(dbSchema.climbProposals.angle),
  ];

  await executor
    .update(dbSchema.climbProposals)
    .set({ status: 'superseded', resolvedAt: new Date() })
    .where(and(...supersedeConditions));

  const [proposal] = await executor
    .insert(dbSchema.climbProposals)
    .values({
      uuid: crypto.randomUUID(),
      climbUuid,
      boardType,
      angle,
      proposerId,
      type,
      proposedValue,
      currentValue,
      reason: reason || null,
    })
    .returning();

  const weight = await getUserVoteWeight(proposerId, boardType, executor);
  await executor.insert(dbSchema.proposalVotes).values({
    proposalId: proposal.id,
    userId: proposerId,
    value: 1,
    weight,
  });

  return proposal;
}

/**
 * Record a +1 vote at the user's weight. Callers must have established that the
 * user has no vote row on this proposal yet — the unique index on
 * (proposal_id, user_id) turns a double call into an error, not a duplicate.
 * Returns the weight the vote carried.
 */
export async function addWeightedUpvote(
  proposal: ProposalRow,
  userId: string,
  executor: ProposalExecutor = db,
): Promise<number> {
  const weight = await getUserVoteWeight(userId, proposal.boardType, executor);
  await executor.insert(dbSchema.proposalVotes).values({
    proposalId: proposal.id,
    userId,
    value: 1,
    weight,
  });
  return weight;
}

/**
 * Turn an existing vote row into a weighted +1, re-reading the user's weight so
 * a downvote cast before they earned (or lost) a role does not carry the old
 * number forward.
 *
 * The report flow needs this because a reporter can already be on the proposal
 * with a -1: they voted the hide down, changed their mind, and reported. Leaving
 * the -1 in place would swallow the report — it is not a duplicate, it is a
 * reversal, and both sides of the tally have to move.
 */
export async function flipVoteToUpvote(
  proposal: ProposalRow,
  voteId: number,
  userId: string,
  executor: ProposalExecutor = db,
): Promise<number> {
  const weight = await getUserVoteWeight(userId, proposal.boardType, executor);
  await executor.update(dbSchema.proposalVotes).set({ value: 1, weight }).where(eq(dbSchema.proposalVotes.id, voteId));
  return weight;
}

/**
 * Approve the proposal if its weighted upvotes now clear the threshold, apply
 * its effect and announce it. Mutates `proposal` in place so the caller's
 * enrichment sees the new status, and returns it for convenience.
 *
 * The open→approved update is guarded on `status = 'open'`, so two callers
 * crossing the threshold at once still produce exactly one approval. That
 * update and the effect share one transaction: a crash between them would leave
 * an approved proposal describing a climb nobody changed, and the guard means
 * the loser of the race rolls back to nothing rather than applying twice.
 *
 * Call it only after the caller's own transaction has committed — the vote
 * counting reads through the `db` singleton, so a pending vote in an
 * uncommitted transaction would be invisible to it.
 */
export async function runAutoApproval(proposal: ProposalRow, actorId: string): Promise<ProposalRow> {
  // Tally, status flip and effect all happen under the proposal's advisory lock
  // in one transaction: counted outside it, a voter toggling off between the
  // count and the flip could approve a proposal that is no longer at threshold.
  const approved = await withProposalLock(proposal.climbUuid, proposal.type, async (tx) => {
    const shouldApprove = await checkAutoApproval(
      proposal.id,
      proposal.boardType,
      proposal.climbUuid,
      proposal.angle,
      tx,
    );
    if (!shouldApprove) return null;

    const [row] = await tx
      .update(dbSchema.climbProposals)
      .set({ status: 'approved', resolvedAt: new Date() })
      .where(and(eq(dbSchema.climbProposals.id, proposal.id), eq(dbSchema.climbProposals.status, 'open')))
      .returning();

    if (!row) return null;

    await applyProposalEffect(proposal, tx);
    return row;
  });

  if (!approved) return proposal;

  proposal.status = 'approved';
  proposal.resolvedAt = approved.resolvedAt;

  void notifyClimbRevalidated(proposal.climbUuid);

  publishSocialEvent({
    type: 'proposal.approved',
    actorId,
    entityType: 'proposal',
    entityId: proposal.uuid,
    timestamp: Date.now(),
    metadata: { climbUuid: proposal.climbUuid, boardType: proposal.boardType, proposalType: proposal.type },
  }).catch((err) => logger.error('[Proposals] Failed to publish proposal.approved:', err));

  return proposal;
}

/** Announce a newly opened proposal to the feed/notification fan-out. */
export function publishProposalCreated(proposal: ProposalRow, actorId: string): void {
  publishSocialEvent({
    type: 'proposal.created',
    actorId,
    entityType: 'proposal',
    entityId: proposal.uuid,
    timestamp: Date.now(),
    metadata: { climbUuid: proposal.climbUuid, boardType: proposal.boardType, proposalType: proposal.type },
  }).catch((err) => logger.error('[Proposals] Failed to publish proposal.created:', err));
}

/** Announce a vote on a proposal. */
export function publishProposalVoted(proposal: ProposalRow, actorId: string, value: number): void {
  publishSocialEvent({
    type: 'proposal.voted',
    actorId,
    entityType: 'proposal',
    entityId: proposal.uuid,
    timestamp: Date.now(),
    metadata: {
      value: String(value),
      climbUuid: proposal.climbUuid,
      boardType: proposal.boardType,
    },
  }).catch((err) => logger.error('[Proposals] Failed to publish proposal.voted:', err));
}

/**
 * Serialise the find-then-write section for one (climb, proposal type) across
 * every backend instance.
 *
 * Two people reporting the same climb within milliseconds both read "no open
 * proposal" and both open one, splitting the votes between two rows that each
 * stall below the threshold. A transaction-scoped Postgres advisory lock closes
 * that window; it covers all instances pointing at the same database and
 * releases at COMMIT/ROLLBACK, so a crashed request can't hold it.
 *
 * Keep the callback to the writes that must not interleave. Auto-approval runs
 * after the commit — see `runAutoApproval`.
 */
export async function withProposalLock<T>(
  climbUuid: string,
  type: ProposalTypeName,
  fn: (tx: ProposalExecutor) => Promise<T>,
): Promise<T> {
  const lockKey = `${climbUuid}:${type}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROPOSAL_LOCK_NAMESPACE}, hashtext(${lockKey}))`);
    return fn(tx);
  });
}
