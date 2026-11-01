import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import * as dbSchema from '@boardsesh/db/schema';
import { getStripeClient, stripeId, supportClaimIdFrom, supportedCurrency } from './stripe-support';
import { withSupportOperation } from './stripe-support-operation';
import {
  applyRemainingCredit,
  linkSubscription,
  loadSupporterRow,
  recordSessionOnce,
  type SupporterRow,
} from './stripe-supporter-sync';
import { creditMonthsFor, extendCredit, isLiveSubscriptionStatus } from './supporter-status';

/** Bounds on one lookup, so a busy email cannot turn one request into hundreds of Stripe calls. */
const SESSION_PAGE_LIMIT = 100;
const SESSION_MAX_PAGES = 5;
const CUSTOMER_LIMIT = 10;
const SUBSCRIPTIONS_PER_CUSTOMER = 20;

export type StripeEmailMatches = {
  sessions: Stripe.Checkout.Session[];
  subscriptions: Stripe.Subscription[];
};

/** Stripe filters email case-sensitively, so try the stored spelling and its lowercase. */
function emailVariants(email: string): string[] {
  return [...new Set([email.trim(), email.trim().toLowerCase()])].filter(Boolean);
}

/** Completed Checkout Sessions and the subscriptions of customers paid with this email. */
export async function findStripeSupportByEmail(email: string): Promise<StripeEmailMatches> {
  const stripe = getStripeClient();
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const subscriptions = new Map<string, Stripe.Subscription>();
  const customerIds = new Set<string>();

  for (const variant of emailVariants(email)) {
    let startingAfter: string | undefined;
    for (let page = 0; page < SESSION_MAX_PAGES; page += 1) {
      const result = await stripe.checkout.sessions.list({
        customer_details: { email: variant },
        status: 'complete',
        limit: SESSION_PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const session of result.data) sessions.set(session.id, session);
      const last = result.data.at(-1);
      if (!result.has_more || !last) break;
      startingAfter = last.id;
    }

    const customers = await stripe.customers.list({ email: variant, limit: CUSTOMER_LIMIT });
    for (const customer of customers.data) customerIds.add(customer.id);
  }

  for (const customerId of [...customerIds].slice(0, CUSTOMER_LIMIT)) {
    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: SUBSCRIPTIONS_PER_CUSTOMER,
    });
    for (const subscription of result.data) subscriptions.set(subscription.id, subscription);
  }

  return { sessions: [...sessions.values()], subscriptions: [...subscriptions.values()] };
}

const SUBSCRIPTION_STATUS_RANK: Readonly<Record<string, number>> = { active: 0, trialing: 1, past_due: 2 };

/**
 * Apply what the lookup found, idempotently: each paid one-off session is
 * ledgered once (keyed by session id), and a live subscription is linked when
 * the account has none. A session another account already claimed with its
 * `sc_` id is left to that account, and so is the subscription it started.
 *
 * Found gifts are credited as of their own payment times: their months are
 * stacked in payment order from each payment date, and only the time still
 * left at `now` is added to the account. A two-year-old gift adds nothing,
 * and a half-used one adds only its unused half, even on top of newer credit.
 */
export async function applyStripeEmailMatches(
  tx: Parameters<typeof recordSessionOnce>[0],
  userId: string,
  matches: StripeEmailMatches,
  now: Date,
): Promise<void> {
  const sessionsInPaymentOrder = [...matches.sessions].sort((left, right) => left.created - right.created);
  const subscriptionsClaimedElsewhere = new Set<string>();
  let foundCreditUntil: Date | null = null;
  let firstPaidAt: Date | null = null;
  let latestCustomerId: string | null = null;
  let recordedAny = false;

  for (const session of sessionsInPaymentOrder) {
    const claimId = supportClaimIdFrom(session.client_reference_id);
    let claim: typeof dbSchema.stripeSupportClaims.$inferSelect | null = null;
    if (claimId) {
      const [found] = await tx
        .select()
        .from(dbSchema.stripeSupportClaims)
        .where(eq(dbSchema.stripeSupportClaims.id, claimId))
        .limit(1);
      if (found && found.userId !== userId) {
        const subscriptionId = stripeId(session.subscription);
        if (subscriptionId) subscriptionsClaimedElsewhere.add(subscriptionId);
        continue;
      }
      claim = found ?? null;
    }
    if (session.mode !== 'payment' || session.payment_status !== 'paid') continue;
    const currency = supportedCurrency(session.currency);
    if (!currency) continue;
    const recorded = await recordSessionOnce(tx, { userId, session, cadence: 'one_time', currency, claim });
    if (!recorded) continue;

    recordedAny = true;
    const paidAt = new Date(session.created * 1000);
    firstPaidAt ??= paidAt;
    latestCustomerId = stripeId(session.customer) ?? latestCustomerId;
    const months = creditMonthsFor(session.amount_total ?? 0, currency);
    if (months > 0) foundCreditUntil = extendCredit(foundCreditUntil, months, paidAt);
  }

  if (recordedAny && firstPaidAt) {
    await applyRemainingCredit(tx, {
      userId,
      remainingMs: foundCreditUntil ? foundCreditUntil.getTime() - now.getTime() : 0,
      customerId: latestCustomerId,
      supportedAt: firstPaidAt,
      now,
    });
  }

  const existing = await loadSupporterRow(tx, userId);
  if (existing?.stripeSubscriptionId && isLiveSubscriptionStatus(existing.subscriptionStatus)) return;
  const liveSubscriptions = matches.subscriptions
    .filter(
      (subscription) =>
        isLiveSubscriptionStatus(subscription.status) && !subscriptionsClaimedElsewhere.has(subscription.id),
    )
    .sort(
      (left, right) =>
        (SUBSCRIPTION_STATUS_RANK[left.status] ?? 9) - (SUBSCRIPTION_STATUS_RANK[right.status] ?? 9) ||
        right.created - left.created,
    );
  for (const subscription of liveSubscriptions) {
    if (await linkSubscription(tx, { userId, subscription, eventCreatedAt: now })) return;
  }
}

/**
 * claimSupporterByEmail: Stripe lookups run outside any transaction under the
 * account's billing lease; the writes commit under the account lock. Null
 * when the account no longer exists.
 */
export async function claimSupporterByEmail(userId: string): Promise<SupporterRow | null | undefined> {
  return withSupportOperation(
    userId,
    'reconciling',
    async (tx) => {
      const [account] = await tx
        .select({ email: dbSchema.users.email, emailVerified: dbSchema.users.emailVerified })
        .from(dbSchema.users)
        .where(eq(dbSchema.users.id, userId))
        .limit(1);
      return account ?? null;
    },
    async (account) => (account?.emailVerified ? findStripeSupportByEmail(account.email) : null),
    async (tx, _account, matches) => {
      if (matches) await applyStripeEmailMatches(tx, userId, matches, new Date());
      return loadSupporterRow(tx, userId);
    },
  );
}
