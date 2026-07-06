import { createHash, randomUUID } from 'node:crypto';
import { eq, and, isNull, desc, count } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { isClaimableDomain, emailDomainMatchesWebsite } from '@boardsesh/gym-claim';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdmin } from './roles';
import { userCanEditGym } from './gyms';
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
  sendGymClaimOwnershipLostEmail,
} from '../../../email/email-service';
import { logger } from '../../../utils/logger';

const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Hash a raw verification token for storage. The raw token only ever lives in the email link. */
export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type ClaimApplied = { gymName: string; claimEmail: string | null; priorOwnerId: string | null };

/**
 * Apply a claim: transfer gym ownership to the claimant. The pending row is
 * flipped to `approved` atomically first — if another transaction already
 * resolved it (double-clicked verify link, concurrent admin approval), this
 * returns null and does nothing, so the transfer + emails happen exactly once.
 * A real prior owner (not the system/import user) is kept on as a gym admin and
 * reported back so they can be notified. Returns null if the gym vanished.
 */
export async function applyGymClaim(
  claim: typeof dbSchema.gymClaims.$inferSelect,
  reviewerId?: string,
): Promise<ClaimApplied | null> {
  return db.transaction(async (tx) => {
    const [gym] = await tx
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.id, claim.gymId), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);
    if (!gym) return null;

    // Claim the pending row atomically; 0 rows means someone else already resolved it.
    const flipped = await tx
      .update(dbSchema.gymClaims)
      .set({ status: 'approved', reviewedBy: reviewerId ?? null, updatedAt: new Date() })
      .where(and(eq(dbSchema.gymClaims.id, claim.id), eq(dbSchema.gymClaims.status, 'pending')))
      .returning({ id: dbSchema.gymClaims.id });
    if (flipped.length === 0) return null;

    const priorOwnerId = gym.ownerId;
    const claimantId = claim.claimantUserId;
    let notifyPriorOwnerId: string | null = null;

    if (priorOwnerId !== claimantId) {
      await tx
        .update(dbSchema.gyms)
        .set({ ownerId: claimantId, updatedAt: new Date() })
        .where(eq(dbSchema.gyms.id, gym.id));

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

    return { gymName: gym.name, claimEmail: claim.claimEmail, priorOwnerId: notifyPriorOwnerId };
  });
}

/** Fire the post-transfer notifications (best-effort): claimant gets a confirmation, the displaced owner a heads-up. */
async function notifyClaimApplied(result: ClaimApplied): Promise<void> {
  if (result.claimEmail) {
    void sendGymClaimApprovedEmail(result.claimEmail, result.gymName);
  }
  if (result.priorOwnerId) {
    const [prior] = await db
      .select({ email: dbSchema.users.email })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, result.priorOwnerId))
      .limit(1);
    if (prior?.email) {
      void sendGymClaimOwnershipLostEmail(prior.email, result.gymName);
    }
  }
}

/**
 * Consume a domain-verification token (from the emailed link) and transfer
 * ownership. Token-gated (no session) — the token is the credential. Used by the
 * backend REST verify route.
 */
export async function verifyGymClaimByToken(
  token: string,
): Promise<{ ok: true; gymName: string } | { ok: false; reason: 'invalid' | 'expired' | 'used' }> {
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
  if (!result) return { ok: false, reason: 'used' };
  await notifyClaimApplied(result);
  return { ok: true, gymName: result.gymName };
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

/** Atomically replace this user's pending claim on this gym with a fresh row. */
async function replacePendingClaim(values: typeof dbSchema.gymClaims.$inferInsert): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(dbSchema.gymClaims)
      .where(
        and(
          eq(dbSchema.gymClaims.gymId, values.gymId),
          eq(dbSchema.gymClaims.claimantUserId, values.claimantUserId),
          eq(dbSchema.gymClaims.status, 'pending'),
        ),
      );
    await tx.insert(dbSchema.gymClaims).values(values);
  });
}

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
    // pending admin claim already exists for this (gym, user).
    if (existingPending?.method === 'admin') {
      return { status: 'admin_review' };
    }

    await replacePendingClaim({
      gymId: gym.id,
      claimantUserId: userId,
      method: 'admin',
      status: 'pending',
      message: validatedInput.message ?? null,
    });

    // Best-effort: the claim is already queued and visible in /admin/gym-claims,
    // so a failed notification (SMTP down) must not throw — that would roll the
    // request back into a GraphQL error while the row stays committed, and the
    // dedup check would then suppress the re-notify on retry, silently stranding
    // the admin. Log it for ops instead; the queue is the source of truth.
    try {
      await sendGymClaimAdminNotification({
        gymName: gym.name,
        gymUuid: gym.uuid,
        claimantName,
        message: validatedInput.message ?? null,
      });
    } catch (error) {
      logger.warn(
        '[GymClaim] Failed to send admin notification for queued claim:',
        error instanceof Error ? error.message : error,
      );
    }

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
      await db
        .update(dbSchema.gymClaims)
        .set({ status: 'denied', reviewedBy: adminUserId, updatedAt: new Date() })
        .where(eq(dbSchema.gymClaims.id, claim.id));
      return true;
    }

    const result = await applyGymClaim(claim, adminUserId);
    if (!result) {
      // The gym was removed, or the claim was resolved concurrently — don't
      // report a success the admin panel would show as "approved".
      throw new Error('Could not approve this claim — the gym may have been removed or it was already resolved');
    }
    await notifyClaimApplied(result);
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
