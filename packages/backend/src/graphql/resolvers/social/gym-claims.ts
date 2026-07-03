import { createHash, randomUUID } from 'node:crypto';
import { eq, and, isNull, desc, count } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { isClaimableDomain, emailDomainMatchesWebsite } from '@boardsesh/gym-claim';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdmin } from './roles';
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
} from '../../../email/email-service';

const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Hash a raw verification token for storage. The raw token only ever lives in the email link. */
export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Apply a claim: transfer gym ownership to the claimant. A real prior owner (not
 * the system/import user) is kept on as a gym admin so they don't lose access.
 * Marks the claim approved. Returns the gym name + claim email for the follow-up
 * notification, or null if the gym vanished.
 */
export async function applyGymClaim(
  claim: typeof dbSchema.gymClaims.$inferSelect,
  reviewerId?: string,
): Promise<{ gymName: string; claimEmail: string | null } | null> {
  return db.transaction(async (tx) => {
    const [gym] = await tx
      .select()
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.id, claim.gymId), isNull(dbSchema.gyms.deletedAt)))
      .limit(1);
    if (!gym) return null;

    const priorOwnerId = gym.ownerId;
    const claimantId = claim.claimantUserId;

    if (priorOwnerId !== claimantId) {
      await tx
        .update(dbSchema.gyms)
        .set({ ownerId: claimantId, updatedAt: new Date() })
        .where(eq(dbSchema.gyms.id, gym.id));

      // Keep a real prior owner on as a gym admin (never the system import user).
      if (priorOwnerId !== SYSTEM_BOARD_OWNER_ID) {
        await tx
          .insert(dbSchema.gymMembers)
          .values({ gymId: gym.id, userId: priorOwnerId, role: 'admin' })
          .onConflictDoNothing();
      }

      // The claimant is the owner now; drop any leftover membership row for them.
      await tx
        .delete(dbSchema.gymMembers)
        .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, claimantId)));
    }

    await tx
      .update(dbSchema.gymClaims)
      .set({ status: 'approved', reviewedBy: reviewerId ?? null, updatedAt: new Date() })
      .where(eq(dbSchema.gymClaims.id, claim.id));

    return { gymName: gym.name, claimEmail: claim.claimEmail };
  });
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
      .where(eq(dbSchema.gymClaims.id, claim.id));
    return { ok: false, reason: 'expired' };
  }

  const result = await applyGymClaim(claim);
  if (!result) return { ok: false, reason: 'invalid' };
  if (result.claimEmail) {
    void sendGymClaimApprovedEmail(result.claimEmail, result.gymName);
  }
  return { ok: true, gymName: result.gymName };
}

/** Remove any open (pending) claim this user already has on this gym, so a new one is the only live claim. */
async function clearPendingClaims(gymId: number, claimantUserId: string): Promise<void> {
  await db
    .delete(dbSchema.gymClaims)
    .where(
      and(
        eq(dbSchema.gymClaims.gymId, gymId),
        eq(dbSchema.gymClaims.claimantUserId, claimantUserId),
        eq(dbSchema.gymClaims.status, 'pending'),
      ),
    );
}

export const socialGymClaimQueries = {
  pendingGymClaims: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const validatedInput = validateInput(PendingGymClaimsInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    const [countResult] = await db
      .select({ count: count() })
      .from(dbSchema.gymClaims)
      .where(eq(dbSchema.gymClaims.status, 'pending'));
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
      .where(eq(dbSchema.gymClaims.status, 'pending'))
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

    // Domain-verified path: the claimant supplied a work email.
    if (validatedInput.claimEmail) {
      if (!isClaimableDomain(gym.website)) {
        throw new Error('This gym has no verifiable website domain on file. Request admin review instead.');
      }
      if (!emailDomainMatchesWebsite(validatedInput.claimEmail, gym.website)) {
        throw new Error("That email's domain doesn't match the gym's website.");
      }

      const token = randomUUID();
      await clearPendingClaims(gym.id, userId);
      await db.insert(dbSchema.gymClaims).values({
        gymId: gym.id,
        claimantUserId: userId,
        method: 'domain',
        status: 'pending',
        claimEmail: validatedInput.claimEmail,
        tokenHash: hashClaimToken(token),
        expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
      });

      await sendGymClaimVerificationEmail(validatedInput.claimEmail, token, gym.name);
      return { status: 'email_sent', email: validatedInput.claimEmail };
    }

    // Admin-review path: no usable email, queue for a human.
    await clearPendingClaims(gym.id, userId);
    await db.insert(dbSchema.gymClaims).values({
      gymId: gym.id,
      claimantUserId: userId,
      method: 'admin',
      status: 'pending',
      message: validatedInput.message ?? null,
    });

    const [claimant] = await db
      .select({ name: dbSchema.users.name, displayName: dbSchema.userProfiles.displayName })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, userId))
      .limit(1);

    await sendGymClaimAdminNotification({
      gymName: gym.name,
      gymUuid: gym.uuid,
      claimantName: claimant?.displayName || claimant?.name || 'A Boardsesh user',
      message: validatedInput.message ?? null,
    });

    return { status: 'admin_review' };
  },

  reviewGymClaim: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 20, 'reviewGymClaim');

    const validatedInput = validateInput(ReviewGymClaimInputSchema, input, 'input');
    const adminUserId = ctx.userId!;

    const [claim] = await db
      .select()
      .from(dbSchema.gymClaims)
      .where(and(eq(dbSchema.gymClaims.id, validatedInput.claimId), eq(dbSchema.gymClaims.status, 'pending')))
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
    if (result?.claimEmail) {
      void sendGymClaimApprovedEmail(result.claimEmail, result.gymName);
    }
    return true;
  },
};
