import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { getStripeClient, isStripeSupportConfigured } from './stripe-support';
import { lockSupportAccount } from './stripe-support-lock';

type SupportClaim = typeof dbSchema.stripeSupportClaims.$inferSelect;
const CLAIM_BATCH_LIMIT = 10;
const SESSION_PAGE_LIMIT = 100;
const SESSION_MAX_PAGES = 10;

/** Only fixed-expiry claims can prove no future payable Checkout can appear. */
async function canReleaseClaim(claim: SupportClaim): Promise<boolean> {
  if (!claim.checkoutExpiresAt) return false;
  const sessions = getStripeClient().checkout.sessions;
  if (claim.checkoutSessionId) {
    const session = await sessions.retrieve(claim.checkoutSessionId);
    return session.client_reference_id === claim.id && session.status === 'expired';
  }

  let startingAfter: string | undefined;
  for (let pageIndex = 0; pageIndex < SESSION_MAX_PAGES; pageIndex += 1) {
    const page = await sessions.list({
      limit: SESSION_PAGE_LIMIT,
      created: {
        gte: Math.floor(claim.createdAt.getTime() / 1000) - 60,
        lte: Math.ceil(claim.checkoutExpiresAt.getTime() / 1000),
      },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (page.data.some((session) => session.client_reference_id === claim.id && session.status !== 'expired')) {
      return false;
    }
    if (!page.has_more) return true;
    const lastSession = page.data.at(-1);
    if (!lastSession) return false;
    startingAfter = lastSession.id;
  }
  // A partial scan cannot prove the absence of a paid or still pending session.
  logger.warn('[stripe-support] Checkout scan truncated; manually reconcile claim with Stripe before release', {
    claimId: claim.id,
    sessionLimit: SESSION_PAGE_LIMIT * SESSION_MAX_PAGES,
  });
  return false;
}

/**
 * Recover abandoned claims without discarding paid or delayed Checkout events.
 * Call before the creation/deletion transaction, since this acquires its own lock.
 * Each call checks at most 10 claims and 1,000 Stripe sessions per unknown claim.
 */
export async function reconcileExpiredSupportClaims(userId: string): Promise<void> {
  if (!isStripeSupportConfigured()) return;
  await db.transaction(async (transaction) => {
    const account = await lockSupportAccount(transaction, userId);
    if (!account) return;
    const expiredClaims = await transaction
      .select()
      .from(dbSchema.stripeSupportClaims)
      .where(
        and(
          eq(dbSchema.stripeSupportClaims.userId, userId),
          isNotNull(dbSchema.stripeSupportClaims.checkoutExpiresAt),
          lte(dbSchema.stripeSupportClaims.checkoutExpiresAt, new Date()),
        ),
      )
      .orderBy(asc(dbSchema.stripeSupportClaims.checkoutExpiresAt), asc(dbSchema.stripeSupportClaims.id))
      .limit(CLAIM_BATCH_LIMIT);
    for (const claim of expiredClaims) {
      let canRelease = false;
      try {
        canRelease = await canReleaseClaim(claim);
      } catch (error) {
        logger.warn('[stripe-support] Stripe reconciliation failed; retaining claim', { claimId: claim.id, error });
        continue;
      }
      if (canRelease) {
        await transaction.delete(dbSchema.stripeSupportClaims).where(eq(dbSchema.stripeSupportClaims.id, claim.id));
      } else {
        logger.warn('[stripe-support] retained expired claim requiring webhook reconciliation', { claimId: claim.id });
      }
    }
  });
}
