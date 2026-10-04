import type Stripe from 'stripe';
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { logger } from '../utils/logger';
import { getStripeClient, isStripeSupportConfigured } from './stripe-support';
import { withSupportOperation } from './stripe-support-operation';

type SupportClaim = typeof dbSchema.stripeSupportClaims.$inferSelect;
const CLAIM_BATCH_LIMIT = 10;
const SESSION_PAGE_LIMIT = 100;
const SESSION_MAX_PAGES = 10;
const RECONCILIATION_BUDGET_MS = 15_000;

function reconciliationOptions(deadline: number): Stripe.RequestOptions {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('Stripe reconciliation time budget exhausted');
  return { timeout: Math.min(5_000, remainingMs), maxNetworkRetries: 0 };
}

/** Only fixed-expiry claims can prove no future payable Checkout can appear. */
async function canReleaseClaim(claim: SupportClaim, deadline: number): Promise<boolean> {
  if (!claim.checkoutExpiresAt) return false;
  const sessions = getStripeClient().checkout.sessions;
  if (claim.checkoutSessionId) {
    const session = await sessions.retrieve(claim.checkoutSessionId, reconciliationOptions(deadline));
    return session.client_reference_id === claim.id && session.status === 'expired';
  }

  let startingAfter: string | undefined;
  for (let pageIndex = 0; pageIndex < SESSION_MAX_PAGES; pageIndex += 1) {
    const page = await sessions.list(
      {
        limit: SESSION_PAGE_LIMIT,
        created: {
          gte: Math.floor(claim.createdAt.getTime() / 1000) - 60,
          lte: Math.ceil(claim.checkoutExpiresAt.getTime() / 1000),
        },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      reconciliationOptions(deadline),
    );
    if (page.data.some((session) => session.client_reference_id === claim.id && session.status !== 'expired')) {
      return false;
    }
    if (!page.has_more) return true;
    const lastSession = page.data.at(-1);
    if (!lastSession) {
      logger.warn('[stripe-support] empty Stripe page with has_more; retaining claim', { claimId: claim.id });
      return false;
    }
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
 * Stripe scans run outside transactions under a persisted billing reservation.
 * Each call checks at most 10 claims and 1,000 Stripe sessions per unknown claim.
 */
export async function reconcileExpiredSupportClaims(userId: string): Promise<void> {
  if (!isStripeSupportConfigured()) return;
  await withSupportOperation(
    userId,
    'reconciling',
    async (transaction) =>
      transaction
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
        .limit(CLAIM_BATCH_LIMIT),
    async (expiredClaims) => {
      const deadline = Date.now() + RECONCILIATION_BUDGET_MS;
      const releasableClaims: SupportClaim[] = [];
      for (const claim of expiredClaims) {
        try {
          if (await canReleaseClaim(claim, deadline)) {
            releasableClaims.push(claim);
          } else {
            logger.warn('[stripe-support] retained expired claim requiring webhook reconciliation', {
              claimId: claim.id,
            });
          }
        } catch (error) {
          logger.warn('[stripe-support] Stripe reconciliation failed; retaining claim', { claimId: claim.id, error });
        }
      }
      return releasableClaims;
    },
    async (transaction, _expiredClaims, releasableClaims) => {
      for (const claim of releasableClaims) {
        if (!claim.checkoutExpiresAt) continue;
        // Finalization is fenced by the operation helper. Bind the delete to
        // the exact expiry and session inspected outside this transaction too.
        await transaction
          .delete(dbSchema.stripeSupportClaims)
          .where(
            and(
              eq(dbSchema.stripeSupportClaims.id, claim.id),
              eq(dbSchema.stripeSupportClaims.userId, userId),
              eq(dbSchema.stripeSupportClaims.checkoutExpiresAt, claim.checkoutExpiresAt),
              lte(dbSchema.stripeSupportClaims.checkoutExpiresAt, new Date()),
              claim.checkoutSessionId
                ? eq(dbSchema.stripeSupportClaims.checkoutSessionId, claim.checkoutSessionId)
                : isNull(dbSchema.stripeSupportClaims.checkoutSessionId),
            ),
          );
      }
    },
  );
}
