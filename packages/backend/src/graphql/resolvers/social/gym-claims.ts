import { createHash, randomUUID } from 'node:crypto';
import { eq, ne, gt, or, and, isNull, desc, count } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { isClaimableDomain, emailDomainMatchesWebsite } from '@boardsesh/gym-claim';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdmin } from './roles';
import { gymClaimAutoApproveEnabled } from './community-settings';
import { userCanEditGym } from './gyms';
import { createGymManageAccessNotification } from './gym-notifications';
import {
  RequestGymClaimInputSchema,
  ReviewGymClaimInputSchema,
  PendingGymClaimsInputSchema,
} from '../../../validation/schemas';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import {
  sendGymClaimVerificationEmail,
  sendGymClaimAdminNotification,
  sendGymClaimApprovedEmail,
  sendGymClaimDeniedEmail,
  sendGymClaimOwnershipLostEmail,
} from '../../../email/email-service';
import { logger } from '../../../utils/logger';

const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many gyms one account may have waiting on review at once. The unique index
 * caps one pending claim per (gym, claimant), so without this a single account
 * could sit on a claim for every gym in the directory — flooding both the review
 * queue and the ops inbox. Ten is far above any real operator's estate (the
 * largest chains on the listing run single digits) and low enough that the queue
 * stays reviewable.
 */
export const MAX_PENDING_CLAIMS_PER_USER = 10;

/** `extensions.code` on the cap rejection, so clients can branch without scraping the message. */
export const GYM_CLAIM_LIMIT_CODE = 'GYM_CLAIM_LIMIT_REACHED';

/**
 * `extensions.code` when the claim is older than the gym's current ownership —
 * someone already decided who owns this gym after the claim was filed, so
 * applying it now would silently reverse that decision.
 */
export const GYM_CLAIM_SUPERSEDED_CODE = 'GYM_CLAIM_SUPERSEDED';

/**
 * A claim that is genuinely still live: `pending` AND not past its expiry.
 *
 * The status column alone is not enough. A domain claim's token dies after 24h,
 * but the row is only flipped to `expired` when someone clicks the dead link —
 * there is no sweeper and no cron — so a row can sit `pending` forever holding a
 * token that can never work again. Anything that asks "does this user have a
 * claim in flight?" has to read the clock too, or a dead claim keeps the
 * claimant's slot AND makes the gym page tell them to check an inbox for a link
 * that is already useless.
 */
function claimIsLive() {
  return and(
    eq(dbSchema.gymClaims.status, 'pending'),
    or(isNull(dbSchema.gymClaims.expiresAt), gt(dbSchema.gymClaims.expiresAt, new Date())),
  );
}

/** Hash a raw verification token for storage. The raw token only ever lives in the email link. */
export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type ClaimApplied = {
  gymName: string;
  gymUuid: string;
  /** Slug for a friendly manage URL; null for slug-less (legacy) gyms — fall back to the UUID. */
  gymSlug: string | null;
  claimantUserId: string;
  claimEmail: string | null;
  priorOwnerId: string | null;
};

/**
 * Why an apply did not happen. `superseded` is its own outcome rather than a
 * flavour of "not applied" because the two need opposite handling: a not-applied
 * claim is already resolved or the gym is gone (nothing left to do), while a
 * superseded one is still `pending` and needs a human to deny it or move
 * ownership deliberately.
 */
export type ApplyGymClaimResult =
  | { outcome: 'applied'; applied: ClaimApplied }
  | { outcome: 'superseded' }
  | { outcome: 'not_applied' };

/**
 * Has anyone decided who owns this gym since `claim` was filed?
 *
 * Exactly two code paths move `gyms.owner_id` — this function's own transfer and
 * `reassignGymOwner` — and both leave a dated record: an admin handover writes a
 * `gym_owner_reassignments` row, and a claim-driven transfer is dated by the
 * approved claim row itself (an approved claim's `updated_at` IS its approval
 * time). Reading both is therefore an exhaustive answer, with no new bookkeeping
 * and no lock held across the decision.
 *
 * Anything newer than the claim means applying it now would reverse a decision
 * somebody made with more information than the claim carries.
 */
async function ownershipMovedSinceClaim(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  gymUuid: string,
  claim: typeof dbSchema.gymClaims.$inferSelect,
): Promise<boolean> {
  const [reassignment] = await tx
    .select({ id: dbSchema.gymOwnerReassignments.id })
    .from(dbSchema.gymOwnerReassignments)
    .where(
      and(
        eq(dbSchema.gymOwnerReassignments.gymUuid, gymUuid),
        gt(dbSchema.gymOwnerReassignments.createdAt, claim.createdAt),
      ),
    )
    .limit(1);
  if (reassignment) return true;

  const [approvedSince] = await tx
    .select({ id: dbSchema.gymClaims.id })
    .from(dbSchema.gymClaims)
    .where(
      and(
        eq(dbSchema.gymClaims.gymId, claim.gymId),
        ne(dbSchema.gymClaims.id, claim.id),
        eq(dbSchema.gymClaims.status, 'approved'),
        gt(dbSchema.gymClaims.updatedAt, claim.createdAt),
      ),
    )
    .limit(1);
  return approvedSince !== undefined;
}

/**
 * Apply a claim: transfer gym ownership to the claimant. The pending row is
 * flipped to `approved` atomically first — if another transaction already
 * resolved it (double-clicked verify link, concurrent admin approval), this
 * returns `not_applied` and does nothing, so the transfer + emails happen
 * exactly once. A real prior owner (not the system/import user) is kept on as a
 * gym admin and reported back so they can be notified. Also `not_applied` if
 * the gym vanished.
 *
 * A claim older than the gym's current ownership returns `superseded` having
 * written NOTHING — not even the status flip. Approving it would move ownership
 * back to the claimant, demote whoever an admin chose to a membership row, mail
 * them "someone verified they manage this gym" (false for a handover), and
 * re-stamp `syncFrozenAt`, which `reassignGymOwner` goes out of its way to leave
 * alone. The row stays `pending` so the claimant still gets a real outcome from
 * the existing Deny path instead of being closed out silently.
 *
 * `requireCurrentOwnerId` narrows the apply to a gym still owned by that user —
 * the auto-approval path passes the system import user so it can only ever hand
 * over an unclaimed listing. The gym is re-checked here, inside the transaction
 * and before the claim row is flipped, so a rejected apply leaves the claim
 * `pending` for a human to review.
 */
export async function applyGymClaim(
  claim: typeof dbSchema.gymClaims.$inferSelect,
  opts: { reviewerId?: string; requireCurrentOwnerId?: string } = {},
): Promise<ApplyGymClaimResult> {
  const { reviewerId, requireCurrentOwnerId } = opts;
  return db.transaction(async (tx) => {
    const [gym] = await tx
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.id, claim.gymId), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);
    if (!gym) return { outcome: 'not_applied' };
    if (requireCurrentOwnerId !== undefined && gym.ownerId !== requireCurrentOwnerId) {
      return { outcome: 'not_applied' };
    }

    // Only a claim that would actually move the gym can undo someone's decision.
    // When the claimant already owns it — an admin who handed the gym straight
    // to them rather than working the queue — the transfer block below is a
    // no-op, so approving is how that claim finally gets an outcome. Refusing it
    // would strand the row with Deny (and its "sorry, no" email) as the only way
    // out, for the person who was in fact given the gym.
    //
    // No `FOR UPDATE`: a handover committing between this read and the transfer
    // makes the owner-guarded UPDATE below match 0 rows and roll the whole
    // transaction back, which is the behaviour the concurrency tests pin.
    if (gym.ownerId !== claim.claimantUserId && (await ownershipMovedSinceClaim(tx, gym.uuid, claim))) {
      return { outcome: 'superseded' };
    }

    // Claim the pending row atomically; 0 rows means someone else already resolved it.
    const flipped = await tx
      .update(dbSchema.gymClaims)
      .set({ status: 'approved', reviewedBy: reviewerId ?? null, updatedAt: new Date() })
      .where(and(eq(dbSchema.gymClaims.id, claim.id), eq(dbSchema.gymClaims.status, 'pending')))
      .returning({ id: dbSchema.gymClaims.id });
    if (flipped.length === 0) return { outcome: 'not_applied' };

    const priorOwnerId = gym.ownerId;
    const claimantId = claim.claimantUserId;
    let notifyPriorOwnerId: string | null = null;

    if (priorOwnerId !== claimantId) {
      const transferred = await tx
        .update(dbSchema.gyms)
        // Taking ownership is a strong human-curation signal — freeze the gym so
        // the location sync stops reshaping the listing the new owner now controls.
        .set({ ownerId: claimantId, syncFrozenAt: new Date(), updatedAt: new Date() })
        // The gym was read above without a row lock, so re-assert the owner we
        // based this decision on. A concurrent transfer means our read is stale:
        // throw to roll the whole transaction back (claim flip included) rather
        // than overwrite the winner.
        .where(and(eq(dbSchema.gyms.id, gym.id), eq(dbSchema.gyms.ownerId, priorOwnerId)))
        .returning({ id: dbSchema.gyms.id });
      if (transferred.length === 0) {
        throw new Error('Gym ownership changed while this claim was being applied');
      }

      // Keep a real prior owner on as a gym admin (never the system import user).
      // Upsert to admin so an existing lower-role membership row is upgraded, not left behind.
      if (priorOwnerId !== SYSTEM_BOARD_OWNER_ID) {
        await tx
          .insert(dbSchema.gymMembers)
          .values({ gymId: gym.id, userId: priorOwnerId, role: 'admin' })
          .onConflictDoUpdate({
            target: [dbSchema.gymMembers.gymId, dbSchema.gymMembers.userId],
            set: { role: 'admin' },
          });
        notifyPriorOwnerId = priorOwnerId;
      }

      // The claimant is the owner now; drop any leftover membership row for them.
      await tx
        .delete(dbSchema.gymMembers)
        .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, claimantId)));
    }

    return {
      outcome: 'applied',
      applied: {
        gymName: gym.name,
        gymUuid: gym.uuid,
        gymSlug: gym.slug,
        claimantUserId: claimantId,
        claimEmail: claim.claimEmail,
        priorOwnerId: notifyPriorOwnerId,
      },
    };
  });
}

/** A user's account email, for the claim outcome emails. Null when the row is gone. */
async function loadUserEmail(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: dbSchema.users.email })
    .from(dbSchema.users)
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Fire the post-transfer notifications (best-effort): the claimant gets an in-app
 * notification and an email, and a displaced real owner a heads-up.
 *
 * `claimEmail` is only ever set on the domain path (it's the address the
 * verification link went to), so for every admin-reviewed claim — which is
 * ~99.9% of them, since almost no gym has a verifiable website on file — the
 * approval email used to go nowhere at all. Fall back to the claimant's account
 * email so an approval is actually delivered.
 *
 * Every caller runs this AFTER `applyGymClaim` has committed the transfer, so
 * nothing in here may throw: the gym has already changed hands, and a Postgres
 * hiccup on the address lookup would otherwise hand the admin a GraphQL error
 * for an approval that in fact went through. Telling someone about a transfer
 * is strictly less important than the transfer itself.
 */
async function notifyClaimApplied(result: ClaimApplied): Promise<void> {
  try {
    await createGymManageAccessNotification(result.claimantUserId, result.gymUuid, result.gymName);
    const claimantEmail = result.claimEmail ?? (await loadUserEmail(result.claimantUserId));
    if (claimantEmail) {
      void sendGymClaimApprovedEmail(claimantEmail, result.gymName);
    }
    if (result.priorOwnerId) {
      const priorOwnerEmail = await loadUserEmail(result.priorOwnerId);
      if (priorOwnerEmail) {
        void sendGymClaimOwnershipLostEmail(priorOwnerEmail, result.gymName);
      }
    }
  } catch (error) {
    logger.warn(
      `[GymClaim] Ownership of gym ${result.gymUuid} transferred to ${result.claimantUserId}, but notifying them failed:`,
      error,
    );
  }
}

/**
 * Consume a domain-verification token (from the emailed link) and transfer
 * ownership. Token-gated (no session) — the token is the credential. Used by the
 * backend REST verify route.
 */
export async function verifyGymClaimByToken(
  token: string,
): Promise<
  | { ok: true; gymName: string; gymSlug: string | null; gymUuid: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'superseded' }
> {
  if (!token) return { ok: false, reason: 'invalid' };
  const tokenHash = hashClaimToken(token);

  const [claim] = await db
    .select()
    .from(dbSchema.gymClaims)
    .where(and(eq(dbSchema.gymClaims.tokenHash, tokenHash), eq(dbSchema.gymClaims.method, 'domain')))
    .limit(1);

  if (!claim) return { ok: false, reason: 'invalid' };
  if (claim.status !== 'pending') return { ok: false, reason: 'used' };
  if (claim.expiresAt && claim.expiresAt.getTime() < Date.now()) {
    await db
      .update(dbSchema.gymClaims)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(dbSchema.gymClaims.id, claim.id), eq(dbSchema.gymClaims.status, 'pending')));
    return { ok: false, reason: 'expired' };
  }

  const result = await applyGymClaim(claim);
  // Not 'used': the link still works, the gym just isn't this claimant's to take
  // any more. The claim stays pending so an admin can resolve it deliberately.
  if (result.outcome === 'superseded') {
    logger.warn(`[GymClaim] Domain claim ${claim.id} on gym ${claim.gymId} was superseded; leaving it pending`);
    return { ok: false, reason: 'superseded' };
  }
  if (result.outcome !== 'applied') return { ok: false, reason: 'used' };
  const { applied } = result;
  await notifyClaimApplied(applied);
  return { ok: true, gymName: applied.gymName, gymSlug: applied.gymSlug, gymUuid: applied.gymUuid };
}

/**
 * Auto-approve an admin-review claim when the admin setting is on AND the gym is
 * still owned by the system import user — an unclaimed location-sync listing
 * nobody has taken. Claims that would displace a real person are deliberately
 * left in the queue for a human, so turning the setting on can't be used to take
 * a gym away from its owner.
 *
 * Returns the applied claim, or null when auto-approval didn't happen (setting
 * off, gym owned by someone, or the claim was resolved concurrently) — in which
 * case the caller falls through to the normal review queue.
 *
 * Auto-approval is an optimisation over that queue, never a precondition for it,
 * so a failure to apply must not fail the request: the claim row is already
 * committed as `pending` by the time we get here. `applyGymClaim` throws when a
 * concurrent request transferred the gym out from under our read — that rolls
 * its own transaction back (leaving the claim `pending`, which is correct), and
 * swallowing it here degrades to `admin_review` instead of handing the user a
 * server error for a claim that is in fact safely queued.
 *
 * That includes the rate limit, which bounds how many gyms one account can be
 * handed instantly. Unlike requestGymClaim's own limit — which runs before
 * anything is written, so throwing leaves nothing behind — this one runs after
 * the claim row is committed. Exhausting it therefore means "don't auto-approve
 * this one", not "reject the request": the claim stays queued for a human.
 *
 * Auto-approved rows are recognisable as `method='admin' AND status='approved'
 * AND reviewed_by IS NULL`; there's no dedicated column, so no migration.
 */
async function tryAutoApproveAdminClaim(
  ctx: ConnectionContext,
  gym: typeof dbSchema.gyms.$inferSelect,
  claim: typeof dbSchema.gymClaims.$inferSelect,
): Promise<ClaimApplied | null> {
  if (!(await gymClaimAutoApproveEnabled())) return null;

  try {
    // Tighter than requestGymClaim's own limit: each pass here can hand over a
    // gym. The cap is global rather than per-instance — the caller is always
    // authenticated (requestGymClaim requires it), so applyRateLimit's tier-2
    // Redis bucket on `${userId}:gymClaimAutoApprove` applies on top of the
    // tier-1 in-process one.
    await applyRateLimit(ctx, 3, 'gymClaimAutoApprove');

    const result = await applyGymClaim(claim, { requireCurrentOwnerId: SYSTEM_BOARD_OWNER_ID });
    if (result.outcome === 'superseded') {
      logger.warn(`[GymClaim] Claim ${claim.id} on gym ${gym.uuid} was superseded; leaving it queued`);
      return null;
    }
    if (result.outcome !== 'applied') return null;
    logger.info(
      `[GymClaim] Auto-approved claim ${claim.id} on gym ${gym.uuid} for user ${claim.claimantUserId} (unclaimed listing)`,
    );
    return result.applied;
  } catch (error) {
    // Pass the Error itself, not `.message` — winston serializes the stack.
    logger.warn(`[GymClaim] Auto-approval of claim ${claim.id} on gym ${gym.uuid} failed; leaving it queued:`, error);
    return null;
  }
}

/** The single pending claim (if any) this user has on this gym. */
async function findPendingClaim(
  gymId: number,
  claimantUserId: string,
): Promise<typeof dbSchema.gymClaims.$inferSelect | undefined> {
  const [existing] = await db
    .select()
    .from(dbSchema.gymClaims)
    .where(
      and(
        eq(dbSchema.gymClaims.gymId, gymId),
        eq(dbSchema.gymClaims.claimantUserId, claimantUserId),
        eq(dbSchema.gymClaims.status, 'pending'),
      ),
    )
    .limit(1);
  return existing;
}

/**
 * Atomically replace this user's pending claim on this gym with a fresh row, and
 * hand the inserted row back so a caller (auto-approval) can act on it without a
 * second round-trip — and without a window where the row could already be gone.
 */
async function replacePendingClaim(
  values: typeof dbSchema.gymClaims.$inferInsert,
): Promise<typeof dbSchema.gymClaims.$inferSelect> {
  return db.transaction(async (tx) => {
    await tx
      .delete(dbSchema.gymClaims)
      .where(
        and(
          eq(dbSchema.gymClaims.gymId, values.gymId),
          eq(dbSchema.gymClaims.claimantUserId, values.claimantUserId),
          eq(dbSchema.gymClaims.status, 'pending'),
        ),
      );
    const [inserted] = await tx.insert(dbSchema.gymClaims).values(values).returning();
    // A successful INSERT ... RETURNING always yields a row, but the destructure
    // is typed as possibly-undefined and the caller feeds this straight into
    // applyGymClaim. Fail here rather than forward an undefined claim.
    if (!inserted) throw new Error('Failed to create gym claim: insert returned no rows');
    return inserted;
  });
}

/**
 * How many live claims this account is already sitting on, ignoring the gym
 * being claimed now (re-submitting there replaces the row rather than adding
 * one, so it must not count against the claimant).
 *
 * Expired-but-unswept domain rows are excluded via `claimIsLive`: nothing in the
 * product flips them, so counting them would let a dead claim occupy a slot
 * forever with no user-reachable way to clear it.
 */
async function countOtherLivePendingClaims(claimantUserId: string, excludedGymId: number): Promise<number> {
  const [pending] = await db
    .select({ count: count() })
    .from(dbSchema.gymClaims)
    .where(
      and(
        eq(dbSchema.gymClaims.claimantUserId, claimantUserId),
        claimIsLive(),
        ne(dbSchema.gymClaims.gymId, excludedGymId),
      ),
    );
  return Number(pending?.count ?? 0);
}

/**
 * Refuse a new claim once this account already holds MAX_PENDING_CLAIMS_PER_USER
 * live ones elsewhere.
 *
 * A soft flood cap, not a guarantee: it is a check-then-insert, so concurrent
 * submissions can both pass it. `requestGymClaim`'s own rate limit (10 per
 * window) bounds how far past the cap that can go — roughly 20 rows, not
 * unbounded — which is all this needs to do.
 *
 * Returns the backlog it counted, so a caller that also wants to report it
 * doesn't run the same query twice.
 */
async function assertPendingClaimBudget(claimantUserId: string, excludedGymId: number): Promise<number> {
  const otherPending = await countOtherLivePendingClaims(claimantUserId, excludedGymId);
  if (otherPending >= MAX_PENDING_CLAIMS_PER_USER) {
    throw new GraphQLError(
      `You already have ${MAX_PENDING_CLAIMS_PER_USER} gym claims waiting on review. Wait for those to be decided before claiming another gym.`,
      { extensions: { code: GYM_CLAIM_LIMIT_CODE, limit: MAX_PENDING_CLAIMS_PER_USER } },
    );
  }
  return otherPending;
}

/**
 * Tell the admin inbox about a queued claim. EVERY queued claim mails — the
 * batching is in the content, not in the delivery.
 *
 * Suppressing the send for a claimant who already has a backlog looks tempting
 * and is a trap: the send is deliberately best-effort (the row is already
 * committed and visible in /admin/gym-claims, so a dead SMTP must not turn a
 * successfully queued claim into a GraphQL error), so one swallowed failure
 * would silently mute every later claim that account ever files — the exact
 * outcome batching was meant to prevent. Two concurrent submissions would both
 * see a backlog and both stay quiet, too.
 *
 * So instead, a claim filed on top of a backlog carries the backlog with it:
 * the mail leads with how many that claimant now has waiting, and points at the
 * queue that lists them. The admin still acts once; nothing can go unheard.
 */
async function notifyAdminOfQueuedClaim(details: {
  gymName: string;
  gymUuid: string;
  claimantName: string;
  message: string | null;
  /** This claimant's live pending claims INCLUDING the one just queued. */
  pendingClaimCount: number;
}): Promise<void> {
  try {
    await sendGymClaimAdminNotification(details);
  } catch (error) {
    logger.warn(
      '[GymClaim] Failed to send admin notification for queued claim:',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * `Gym.myPendingClaim` — a lazy field resolver, so the extra query only runs for
 * the one document that selects it (GET_GYM_PENDING_CLAIM, on the web gym
 * page). enrichGym already fires ~9 round trips per gym and runs per row for up
 * to 50 rows in searchGyms, so this deliberately does NOT live there.
 *
 * `claimIsLive` and not just `status = 'pending'`: an expired domain claim is
 * never swept, and returning one would replace the claim call-out with "check
 * your inbox" for a link that can no longer work — a dead end the claimant
 * cannot get out of, since that notice is the gym page's only route to the
 * claim dialog.
 */
export const gymClaimFieldResolvers = {
  myPendingClaim: async (gym: { uuid: string }, _args: unknown, ctx: ConnectionContext) => {
    if (!ctx.isAuthenticated || !ctx.userId) return null;
    const [claim] = await db
      .select({
        id: dbSchema.gymClaims.id,
        method: dbSchema.gymClaims.method,
        createdAt: dbSchema.gymClaims.createdAt,
      })
      .from(dbSchema.gymClaims)
      .innerJoin(dbSchema.gyms, eq(dbSchema.gymClaims.gymId, dbSchema.gyms.id))
      .where(and(eq(dbSchema.gyms.uuid, gym.uuid), eq(dbSchema.gymClaims.claimantUserId, ctx.userId), claimIsLive()))
      .orderBy(desc(dbSchema.gymClaims.createdAt))
      .limit(1);
    if (!claim) return null;
    return { id: String(claim.id), method: claim.method, createdAt: claim.createdAt.toISOString() };
  },
};

export const socialGymClaimQueries = {
  pendingGymClaims: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const validatedInput = validateInput(PendingGymClaimsInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Only admin-method claims belong in the review queue — domain claims
    // self-verify via the emailed link and must never be admin-approvable.
    const pendingAdminClaims = and(eq(dbSchema.gymClaims.status, 'pending'), eq(dbSchema.gymClaims.method, 'admin'));

    const [countResult] = await db.select({ count: count() }).from(dbSchema.gymClaims).where(pendingAdminClaims);
    const totalCount = Number(countResult?.count || 0);

    const rows = await db
      .select({
        id: dbSchema.gymClaims.id,
        gymUuid: dbSchema.gyms.uuid,
        gymName: dbSchema.gyms.name,
        claimantUserId: dbSchema.gymClaims.claimantUserId,
        method: dbSchema.gymClaims.method,
        status: dbSchema.gymClaims.status,
        claimEmail: dbSchema.gymClaims.claimEmail,
        message: dbSchema.gymClaims.message,
        createdAt: dbSchema.gymClaims.createdAt,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
      })
      .from(dbSchema.gymClaims)
      .innerJoin(dbSchema.gyms, eq(dbSchema.gymClaims.gymId, dbSchema.gyms.id))
      .leftJoin(dbSchema.users, eq(dbSchema.gymClaims.claimantUserId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.gymClaims.claimantUserId, dbSchema.userProfiles.userId))
      .where(pendingAdminClaims)
      .orderBy(desc(dbSchema.gymClaims.createdAt))
      .limit(limit)
      .offset(offset);

    const claims = rows.map((row) => ({
      id: String(row.id),
      gymUuid: row.gymUuid,
      gymName: row.gymName,
      claimantUserId: row.claimantUserId,
      claimantDisplayName: row.displayName || row.userName || undefined,
      claimantAvatarUrl: row.avatarUrl || row.userImage || undefined,
      method: row.method,
      status: row.status,
      claimEmail: row.claimEmail,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    }));

    return { claims, totalCount, hasMore: offset + rows.length < totalCount };
  },
};

export const socialGymClaimMutations = {
  requestGymClaim: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'requestGymClaim');

    const validatedInput = validateInput(RequestGymClaimInputSchema, input, 'input');
    const userId = ctx.userId!;

    const [gym] = await db
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.uuid, validatedInput.gymUuid), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);
    if (!gym) {
      throw new Error('Gym not found');
    }
    if (gym.ownerId === userId) {
      throw new Error('You already own this gym');
    }
    // Claims are for public listings only. A private gym is someone's personal
    // record, not a listing to be taken over.
    if (!gym.isPublic) {
      throw new Error('This gym is private and cannot be claimed');
    }
    // Anyone who can already edit the gym is not a claimant. Owners are handled
    // above; gym admins/editors and covering community leaders already have edit
    // access. Gate BOTH paths here (not just the domain path): an editor could
    // rewrite `website` to a domain they control and self-verify into ownership,
    // and filing an admin-review claim they can't be granted just wastes a
    // reviewer's time. Mirrors `canClaim` (false for these roles) so the mutation
    // rejects exactly what the UI hides.
    if (await userCanEditGym(gym, userId)) {
      throw new Error('You already have edit access to this gym, so you cannot file an ownership claim here.');
    }

    const claimantName = await loadClaimantName(userId);
    const existingPending = await findPendingClaim(gym.id, userId);

    // Domain-verified path: the claimant supplied a work email.
    if (validatedInput.claimEmail) {
      if (!isClaimableDomain(gym.website)) {
        throw new Error('This gym has no verifiable website domain on file. Request admin review instead.');
      }
      // #3431: only a website the gym's OWNER put on the listing can auto-transfer
      // ownership. A website typed by an editor / gym admin / covering community
      // leader is display-only here — otherwise that person could point it at a
      // domain they control and a second account of theirs would self-verify in.
      // Checked before the email match so a prober can't learn whether their
      // address would have matched.
      // TODO(#4018): both claim dialogs still offer the email form on an
      // un-vouched gym, so this refusal only surfaces after submit.
      if (!gym.websiteVouchedByOwner) {
        throw new Error(
          "This gym's website hasn't been confirmed by the gym's owner, so we can't verify you by email. Request admin review instead.",
        );
      }
      if (!emailDomainMatchesWebsite(validatedInput.claimEmail, gym.website)) {
        throw new Error("That email's domain doesn't match the gym's website.");
      }

      // Don't re-send if the same address already has a live verification email.
      if (
        existingPending?.method === 'domain' &&
        existingPending.claimEmail === validatedInput.claimEmail &&
        (!existingPending.expiresAt || existingPending.expiresAt.getTime() > Date.now())
      ) {
        return { status: 'email_sent', email: validatedInput.claimEmail };
      }

      // Bound outbound verification emails per user (in addition to the general limit).
      await applyRateLimit(ctx, 5, 'gymClaimVerificationEmail');
      await assertPendingClaimBudget(userId, gym.id);

      const token = randomUUID();
      await replacePendingClaim({
        gymId: gym.id,
        claimantUserId: userId,
        method: 'domain',
        status: 'pending',
        claimEmail: validatedInput.claimEmail,
        tokenHash: hashClaimToken(token),
        expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
      });

      try {
        await sendGymClaimVerificationEmail(validatedInput.claimEmail, token, gym.name, claimantName);
      } catch (error) {
        // The token row is already committed; if the send fails (SMTP down),
        // drop it so a retry isn't blocked by the dedup check for 24h.
        await db
          .delete(dbSchema.gymClaims)
          .where(
            and(
              eq(dbSchema.gymClaims.gymId, gym.id),
              eq(dbSchema.gymClaims.claimantUserId, userId),
              eq(dbSchema.gymClaims.status, 'pending'),
              eq(dbSchema.gymClaims.method, 'domain'),
            ),
          );
        throw error;
      }
      return { status: 'email_sent', email: validatedInput.claimEmail };
    }

    // Admin-review path: no usable email, queue for a human. Don't re-notify if a
    // pending admin claim already exists for this (gym, user) — but do retry
    // auto-approval, so a claim queued before the setting was turned on can still
    // go through when the claimant asks again.
    if (existingPending?.method === 'admin') {
      const autoApplied = await tryAutoApproveAdminClaim(ctx, gym, existingPending);
      if (autoApplied) {
        await notifyClaimApplied(autoApplied);
        return { status: 'approved' };
      }
      return { status: 'admin_review' };
    }

    // Read the backlog BEFORE the insert, and use that one number for both the
    // cap and the notification's "N waiting" line — so the count the mail
    // reports can't drift from the count the cap enforced.
    const otherPendingClaims = await assertPendingClaimBudget(userId, gym.id);

    const queuedClaim = await replacePendingClaim({
      gymId: gym.id,
      claimantUserId: userId,
      method: 'admin',
      status: 'pending',
      message: validatedInput.message ?? null,
    });

    const autoApplied = await tryAutoApproveAdminClaim(ctx, gym, queuedClaim);
    if (autoApplied) {
      await notifyClaimApplied(autoApplied);
      return { status: 'approved' };
    }

    await notifyAdminOfQueuedClaim({
      gymName: gym.name,
      gymUuid: gym.uuid,
      claimantName,
      message: validatedInput.message ?? null,
      pendingClaimCount: otherPendingClaims + 1,
    });

    return { status: 'admin_review' };
  },

  reviewGymClaim: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 20, 'reviewGymClaim');

    const validatedInput = validateInput(ReviewGymClaimInputSchema, input, 'input');
    const adminUserId = ctx.userId!;

    // Admins only act on admin-method claims. Domain claims prove themselves via
    // the emailed link, so approving one by id would bypass that proof.
    const [claim] = await db
      .select()
      .from(dbSchema.gymClaims)
      .where(
        and(
          eq(dbSchema.gymClaims.id, validatedInput.claimId),
          eq(dbSchema.gymClaims.status, 'pending'),
          eq(dbSchema.gymClaims.method, 'admin'),
        ),
      )
      .limit(1);
    if (!claim) {
      throw new Error('Claim not found or already resolved');
    }

    if (validatedInput.decision === 'deny') {
      // Re-assert `pending` in the UPDATE itself. The SELECT above ran without a
      // row lock, so a deny racing an approve (a second reviewer, or the
      // claimant's own domain verify link landing) would otherwise stamp
      // `denied` on an already-approved row AFTER ownership had moved — the gym
      // transferred, the audit trail saying it was refused.
      const denied = await db
        .update(dbSchema.gymClaims)
        .set({ status: 'denied', reviewedBy: adminUserId, updatedAt: new Date() })
        .where(and(eq(dbSchema.gymClaims.id, claim.id), eq(dbSchema.gymClaims.status, 'pending')))
        .returning({ id: dbSchema.gymClaims.id });
      if (denied.length === 0) {
        throw new Error('Could not deny this claim — it was already resolved');
      }

      // A denied claimant used to hear nothing, ever: they filed, the CTA
      // stayed put, and no outcome ever arrived. `claimEmail` is only set on
      // the domain path, so the account email is what reaches an admin-path
      // claimant.
      const claimantEmail = claim.claimEmail ?? (await loadUserEmail(claim.claimantUserId));
      if (claimantEmail) {
        const [claimedGym] = await db
          .select({ name: dbSchema.gyms.name })
          .from(dbSchema.gyms)
          .where(eq(dbSchema.gyms.id, claim.gymId))
          .limit(1);
        if (claimedGym) {
          void sendGymClaimDeniedEmail(claimantEmail, claimedGym.name);
        }
      }
      return true;
    }

    // Two of the ways this can fail mean the same thing to the reviewer — the
    // claim wasn't applied — so fold them into one message. `applyGymClaim`
    // returns `not_applied` when the gym is gone or the claim was already
    // resolved, and throws when a concurrent transfer beat us to the guarded
    // UPDATE; letting that throw escape would hand the admin an internal
    // message instead. `superseded` is deliberately NOT folded in — see below.
    let result: ApplyGymClaimResult;
    try {
      result = await applyGymClaim(claim, { reviewerId: adminUserId });
    } catch (error) {
      logger.warn(`[GymClaim] Manual approval of claim ${claim.id} lost an ownership race:`, error);
      result = { outcome: 'not_applied' };
    }

    // Raised outside the catch above on purpose: this one is not "the claim
    // wasn't applied, try again", it is a decision the reviewer has to make.
    // Somebody already settled who owns this gym after the claim was filed, so
    // approving would hand it back and undo them. Deny it, or move ownership on
    // purpose with the handover panel next to the queue.
    if (result.outcome === 'superseded') {
      logger.warn(
        `[GymClaim] Refused approval of claim ${claim.id} on gym ${claim.gymId}: ownership moved after it was filed`,
      );
      throw new GraphQLError('This gym changed hands after the claim was filed.', {
        extensions: { code: GYM_CLAIM_SUPERSEDED_CODE },
      });
    }

    if (result.outcome !== 'applied') {
      // The gym was removed, or the claim was resolved concurrently — don't
      // report a success the admin panel would show as "approved".
      throw new Error('Could not approve this claim — the gym may have been removed or it was already resolved');
    }
    await notifyClaimApplied(result.applied);
    return true;
  },
};

/** The claimant's display name for emails, falling back to a neutral label. */
async function loadClaimantName(userId: string): Promise<string> {
  const [claimant] = await db
    .select({ name: dbSchema.users.name, displayName: dbSchema.userProfiles.displayName })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  return claimant?.displayName || claimant?.name || 'A Boardsesh user';
}
