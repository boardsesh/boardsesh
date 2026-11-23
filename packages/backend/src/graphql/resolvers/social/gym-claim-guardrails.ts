import { and, eq, gt, inArray, isNull, max, ne, sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rolesGrantAdmin } from '@boardsesh/community-roles';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { gymClaimAutoApproveDailyCap } from './community-settings';
import { getUserCommunityRoles } from './roles';

// ============================================
// Claim guardrails (docs/product/gym-claims.md)
// ============================================
//
// Auto-approval hands an unclaimed synced gym to whoever asks, with no human in
// the loop. These are the limits on it, and the 14-day probation that follows:
//
// - The guards decide whether a claim may approve itself at all. They run once
//   before the apply, and again inside it under one advisory lock, so two claims
//   on different gyms cannot both slip under the daily cap.
// - Probation stops anyone at a freshly auto-approved gym from doing what can't
//   be undone by a revert: deleting the gym or its synced boards, removing
//   members, or adding admins (a second account would get round the rest).

type GuardrailExecutor = NonNullable<Parameters<typeof getUserCommunityRoles>[1]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An account younger than this never gets a claim approved without review. */
export const AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS = 30;

/** Days after an auto-approval during which nobody at the gym may delete or remove. */
export const GYM_CLAIM_PROBATION_DAYS = 14;

/** `extensions.code` on every probation refusal; `extensions.endsAt` is when it lifts (ISO). */
export const GYM_CLAIM_PROBATION_CODE = 'GYM_CLAIM_PROBATION';

/**
 * The advisory lock every auto-approval takes before it re-checks the guards
 * and transfers the gym. One fixed key (epic #8043, lock 1): auto-approvals
 * are rare, so serialising all of them costs nothing and is what makes the
 * daily cap and "one per account" hold under concurrency.
 */
const AUTO_APPROVE_LOCK_NAMESPACE = 8043;
const AUTO_APPROVE_LOCK_KEY = 1;

/** Why a claim did not approve itself. Logged and returned; never shown to the claimant. */
export type AutoApproveGuard =
  | 'already_auto_approved'
  | 'account_too_new'
  | 'climber_boards_linked'
  | 'gym_has_staff'
  | 'daily_cap_reached';

/**
 * A claim that approved itself: admin method, no reviewer. A revoked one still
 * counts towards the account's one auto-approval and the daily cap, so the
 * statuses are a parameter.
 */
export function autoApprovedClaimCondition(statuses: readonly dbSchema.GymClaim['status'][] = ['approved']): SQL {
  return and(
    eq(dbSchema.gymClaims.method, 'admin'),
    isNull(dbSchema.gymClaims.reviewedBy),
    inArray(dbSchema.gymClaims.status, [...statuses]),
  )!;
}

/** Take the auto-approval lock for the rest of the transaction. */
export async function lockAutoApprovals(tx: GuardrailExecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUTO_APPROVE_LOCK_NAMESPACE}, ${AUTO_APPROVE_LOCK_KEY})`);
}

/**
 * The first guard this claim fails, or null when it may approve itself
 * (docs/product/gym-board-governance.md, decision 3):
 *
 * 1. The account has never had a claim approve itself.
 * 2. The account is at least {@link AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS} days old.
 * 3. No live board owned by another climber is linked to the gym. A claim like
 *    that hands someone power over other people's boards, so a person decides.
 *    The claimant's own boards and synced (SYSTEM) boards don't count.
 * 4. The gym has no admin or editor (`gym_members`), the claimant's own row
 *    included. An unowned gym with staff is run by someone already: a claim
 *    would put the claimant over them, so a person decides.
 * 5. Fewer than `gym_claim_auto_approve_daily_cap` claims approved themselves
 *    in the last 24 hours, across every account.
 *
 * Whether the gym is still unclaimed is `applyGymClaim`'s
 * `requireCurrentOwnerId` check, not a guard here.
 */
export async function firstFailedAutoApproveGuard(
  executor: GuardrailExecutor,
  claim: Pick<dbSchema.GymClaim, 'id' | 'gymId' | 'claimantUserId'>,
  now: Date = new Date(),
): Promise<AutoApproveGuard | null> {
  const [earlierAutoApproval] = await executor
    .select({ id: dbSchema.gymClaims.id })
    .from(dbSchema.gymClaims)
    .where(
      and(
        eq(dbSchema.gymClaims.claimantUserId, claim.claimantUserId),
        ne(dbSchema.gymClaims.id, claim.id),
        autoApprovedClaimCondition(['approved', 'revoked']),
      ),
    )
    .limit(1);
  if (earlierAutoApproval) return 'already_auto_approved';

  const [account] = await executor
    .select({ createdAt: dbSchema.users.createdAt })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, claim.claimantUserId))
    .limit(1);
  const oldestAllowedCreation = new Date(now.getTime() - AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS * DAY_MS);
  if (!account || account.createdAt.getTime() > oldestAllowedCreation.getTime()) return 'account_too_new';

  const [climberBoard] = await executor
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.gymId, claim.gymId),
        isNull(dbSchema.userBoards.deletedAt),
        ne(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
        ne(dbSchema.userBoards.ownerId, claim.claimantUserId),
      ),
    )
    .limit(1);
  if (climberBoard) return 'climber_boards_linked';

  const [staff] = await executor
    .select({ id: dbSchema.gymMembers.id })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, claim.gymId), inArray(dbSchema.gymMembers.role, ['admin', 'editor'])))
    .limit(1);
  if (staff) return 'gym_has_staff';

  const dailyCap = await gymClaimAutoApproveDailyCap();
  const [recent] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.gymClaims)
    .innerJoin(
      dbSchema.gymClaimOwnershipDecisions,
      eq(dbSchema.gymClaimOwnershipDecisions.claimId, dbSchema.gymClaims.id),
    )
    .where(
      and(
        autoApprovedClaimCondition(['approved', 'revoked']),
        eq(dbSchema.gymClaimOwnershipDecisions.didTransfer, true),
        gt(dbSchema.gymClaimOwnershipDecisions.decidedAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  if ((recent?.count ?? 0) >= dailyCap) return 'daily_cap_reached';

  return null;
}

// ============================================
// Probation
// ============================================

/**
 * When probation ends at each of these gyms that is in it now. A gym is in
 * probation for {@link GYM_CLAIM_PROBATION_DAYS} days after a claim on it
 * approved itself, for as long as that claimant still owns it: a revert, or an
 * admin handover to someone else, ends it. One query for any number of gyms,
 * so board lists can read it without a query per row.
 */
export async function loadGymClaimProbations(
  gymIds: readonly number[],
  executor: GuardrailExecutor = db,
  now: Date = new Date(),
): Promise<Map<number, Date>> {
  const probations = new Map<number, Date>();
  if (gymIds.length === 0) return probations;
  const rows = await executor
    .select({
      gymId: dbSchema.gymClaims.gymId,
      approvedAt: max(dbSchema.gymClaimOwnershipDecisions.decidedAt),
    })
    .from(dbSchema.gymClaims)
    .innerJoin(
      dbSchema.gymClaimOwnershipDecisions,
      eq(dbSchema.gymClaimOwnershipDecisions.claimId, dbSchema.gymClaims.id),
    )
    .innerJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.gymClaims.gymId))
    .where(
      and(
        inArray(dbSchema.gymClaims.gymId, [...new Set(gymIds)]),
        autoApprovedClaimCondition(['approved']),
        eq(dbSchema.gymClaimOwnershipDecisions.didTransfer, true),
        eq(dbSchema.gymClaimOwnershipDecisions.gymUuid, dbSchema.gyms.uuid),
        eq(dbSchema.gyms.ownerId, dbSchema.gymClaims.claimantUserId),
        gt(dbSchema.gymClaimOwnershipDecisions.decidedAt, new Date(now.getTime() - GYM_CLAIM_PROBATION_DAYS * DAY_MS)),
      ),
    )
    .groupBy(dbSchema.gymClaims.gymId);
  for (const row of rows) {
    if (row.approvedAt) {
      probations.set(row.gymId, new Date(row.approvedAt.getTime() + GYM_CLAIM_PROBATION_DAYS * DAY_MS));
    }
  }
  return probations;
}

/** When probation ends at this gym, or null when it is not in probation. */
export async function gymClaimProbationEndsAt(
  gymId: number,
  executor: GuardrailExecutor = db,
  now: Date = new Date(),
): Promise<Date | null> {
  return (await loadGymClaimProbations([gymId], executor, now)).get(gymId) ?? null;
}

/** "7 December 2026", in UTC, for the refusal message. Clients can format `extensions.endsAt` themselves. */
function probationDateLabel(endsAt: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    endsAt,
  );
}

export function gymClaimProbationError(endsAt: Date): GraphQLError {
  return new GraphQLError(
    `For ${GYM_CLAIM_PROBATION_DAYS} days after a gym is claimed, nobody at it can delete the gym or its synced boards, remove members or add admins. This opens on ${probationDateLabel(endsAt)}.`,
    { extensions: { code: GYM_CLAIM_PROBATION_CODE, endsAt: endsAt.toISOString() } },
  );
}

/**
 * Refuse a probation-blocked action at this gym unless the caller is a global
 * admin. Callers have already checked the caller's own authority at the gym.
 */
export async function assertNoGymClaimProbation(
  gymId: number,
  userId: string,
  executor: GuardrailExecutor = db,
): Promise<void> {
  const endsAt = await gymClaimProbationEndsAt(gymId, executor);
  if (endsAt === null) return;
  if (rolesGrantAdmin(await getUserCommunityRoles(userId, executor), null)) return;
  throw gymClaimProbationError(endsAt);
}
