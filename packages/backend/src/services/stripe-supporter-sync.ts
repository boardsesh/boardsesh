import { and, eq, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import * as dbSchema from '@boardsesh/db/schema';
import type { SupportClaimCurrency } from '@boardsesh/db/schema';
import { logger } from '../utils/logger';
import { newSupportClaimId, stripeId } from './stripe-support';
import type { SupportTransaction } from './stripe-support-lock';
import { creditMonthsFor, extendCredit, isLiveSubscriptionStatus } from './supporter-status';

/**
 * The writes both the webhook and claim-by-email make. Every function here
 * runs inside a transaction that already holds the account row lock
 * (`lockSupportAccount`), so two deliveries of the same payment serialize and
 * the second finds the session already in the ledger.
 */

export type SupporterRow = typeof dbSchema.stripeSupporters.$inferSelect;
export type SupportClaim = typeof dbSchema.stripeSupportClaims.$inferSelect;

export async function loadSupporterRow(tx: SupportTransaction, userId: string): Promise<SupporterRow | null> {
  const [row] = await tx
    .select()
    .from(dbSchema.stripeSupporters)
    .where(eq(dbSchema.stripeSupporters.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Put a Checkout Session in the ledger once. True when this call recorded it,
 * false when it was already there (a webhook retry, or the other path got to
 * it first). A claim the climber carried is filled in place; a claim that
 * already holds another session (the same link paid twice), or no claim at
 * all, gets a fresh ledger row.
 */
export async function recordSessionOnce(
  tx: SupportTransaction,
  input: {
    userId: string;
    session: Pick<Stripe.Checkout.Session, 'id' | 'expires_at'>;
    cadence: 'monthly' | 'one_time';
    currency: SupportClaimCurrency;
    claim: SupportClaim | null;
  },
): Promise<boolean> {
  const { userId, session, cadence, currency, claim } = input;
  const [alreadyRecorded] = await tx
    .select({ id: dbSchema.stripeSupportClaims.id })
    .from(dbSchema.stripeSupportClaims)
    .where(eq(dbSchema.stripeSupportClaims.checkoutSessionId, session.id))
    .limit(1);
  if (alreadyRecorded) return false;

  const checkoutExpiresAt = session.expires_at ? new Date(session.expires_at * 1000) : null;
  if (claim && claim.userId === userId && !claim.checkoutSessionId) {
    const filled = await tx
      .update(dbSchema.stripeSupportClaims)
      .set({ checkoutSessionId: session.id, checkoutExpiresAt, currency, cadence })
      .where(and(eq(dbSchema.stripeSupportClaims.id, claim.id), isNull(dbSchema.stripeSupportClaims.checkoutSessionId)))
      .returning({ id: dbSchema.stripeSupportClaims.id });
    if (filled.length > 0) return true;
  }

  const inserted = await tx
    .insert(dbSchema.stripeSupportClaims)
    .values({
      id: newSupportClaimId(),
      userId,
      checkoutSessionId: session.id,
      checkoutExpiresAt,
      cadence,
      currency,
      src: claim?.src ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: dbSchema.stripeSupportClaims.id });
  return inserted.length > 0;
}

/**
 * Add tag time for a one-off gift: whole months per the credit rule, stacked
 * on whichever is later, `now` or the current `credit_until`. A gift under one
 * month still marks the account as having supported.
 */
export async function applyOneOffCredit(
  tx: SupportTransaction,
  input: {
    userId: string;
    amountMinor: number;
    currency: SupportClaimCurrency;
    customerId: string | null;
    now: Date;
  },
): Promise<SupporterRow> {
  const { userId, amountMinor, currency, customerId, now } = input;
  const months = creditMonthsFor(amountMinor, currency);
  return upsertOneOffCredit(tx, {
    userId,
    customerId,
    supportedAt: now,
    nextCreditUntil: (current) => (months > 0 ? extendCredit(current, months, now) : null),
  });
}

/**
 * Add tag time that is already partly used up: claim-by-email finds gifts
 * paid in the past, works out how much of their time is still left at `now`
 * (`remainingMs`), and adds only that, on top of whichever is later, `now`
 * or the current `credit_until`. Stacking a found gift's full months onto
 * newer credit would hand out time that already ran.
 */
export async function applyRemainingCredit(
  tx: SupportTransaction,
  input: { userId: string; remainingMs: number; customerId: string | null; supportedAt: Date; now: Date },
): Promise<SupporterRow> {
  const { userId, remainingMs, customerId, supportedAt, now } = input;
  return upsertOneOffCredit(tx, {
    userId,
    customerId,
    supportedAt,
    nextCreditUntil: (current) => {
      if (remainingMs <= 0) return null;
      const start = current && current.getTime() > now.getTime() ? current : now;
      return new Date(start.getTime() + remainingMs);
    },
  });
}

/**
 * The one upsert behind both credit writers. `nextCreditUntil` gets the
 * current `credit_until` and returns the new one, or null to keep it.
 */
async function upsertOneOffCredit(
  tx: SupportTransaction,
  input: {
    userId: string;
    customerId: string | null;
    supportedAt: Date;
    nextCreditUntil: (current: Date | null) => Date | null;
  },
): Promise<SupporterRow> {
  const { userId, customerId } = input;
  const existing = await loadSupporterRow(tx, userId);
  const extended = input.nextCreditUntil(existing?.creditUntil ?? null);
  const creditUntil = extended ?? existing?.creditUntil ?? null;
  // A linked subscription's customer owns billing; a one-off paid as a guest
  // never replaces it.
  const stripeCustomerId = existing?.stripeSubscriptionId
    ? existing.stripeCustomerId
    : (customerId ?? existing?.stripeCustomerId ?? null);
  const source = extended ? 'stripe' : (existing?.source ?? 'stripe');
  const supportedAt = existing?.supportedAt ?? input.supportedAt;
  const values = { stripeCustomerId, creditUntil, source, supportedAt, updatedAt: new Date() } as const;
  const [row] = await tx
    .insert(dbSchema.stripeSupporters)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: dbSchema.stripeSupporters.userId, set: values })
    .returning();
  return row;
}

/**
 * Link a subscription to an account and store its latest status. A
 * subscription already linked to a different account is left alone (false).
 * The caller passes the subscription as just read from Stripe.
 */
export async function linkSubscription(
  tx: SupportTransaction,
  input: { userId: string; subscription: Stripe.Subscription; eventCreatedAt: Date },
): Promise<boolean> {
  const { userId, subscription, eventCreatedAt } = input;
  const [owner] = await tx
    .select({ userId: dbSchema.stripeSupporters.userId })
    .from(dbSchema.stripeSupporters)
    .where(eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id))
    .limit(1);
  if (owner && owner.userId !== userId) {
    logger.warn('[stripe-support] subscription is linked to another account; not relinking', {
      subscriptionId: subscription.id,
    });
    return false;
  }
  const existing = await loadSupporterRow(tx, userId);
  if (
    existing?.stripeSubscriptionId &&
    existing.stripeSubscriptionId !== subscription.id &&
    isLiveSubscriptionStatus(existing.subscriptionStatus)
  ) {
    logger.warn('[stripe-support] replacing a live linked subscription with a newer one', {
      userId,
      previousSubscriptionId: existing.stripeSubscriptionId,
      subscriptionId: subscription.id,
    });
  }
  const stripeEventCreatedAt =
    existing?.stripeEventCreatedAt && existing.stripeEventCreatedAt > eventCreatedAt
      ? existing.stripeEventCreatedAt
      : eventCreatedAt;
  const values = {
    stripeCustomerId: stripeId(subscription.customer),
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    stripeEventCreatedAt,
    source: 'stripe',
    supportedAt: existing?.supportedAt ?? new Date(),
    updatedAt: new Date(),
  } as const;
  await tx
    .insert(dbSchema.stripeSupporters)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: dbSchema.stripeSupporters.userId, set: values });
  return true;
}
