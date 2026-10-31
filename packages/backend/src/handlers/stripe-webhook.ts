import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { lockSupportAccount } from '../services/stripe-support-lock';
import { withSupportOperation } from '../services/stripe-support-operation';
import {
  getStripeClient,
  isStripeWebhookConfigured,
  stripeId,
  supportClaimIdFrom,
  supportedCurrency,
} from '../services/stripe-support';
import {
  applyOneOffCredit,
  linkSubscription,
  recordSessionOnce,
  type SupportClaim,
} from '../services/stripe-supporter-sync';
import type { SupportClaimCurrency } from '@boardsesh/db/schema';
import { logger } from '../utils/logger';
import { readRawBody, sendJson } from './http-utils';

/** Stripe event payloads are a few KB; this leaves room without inviting abuse. */
export const MAX_STRIPE_WEBHOOK_BYTES = 256 * 1024;

async function loadClaim(claimId: string): Promise<SupportClaim | null> {
  const [claim] = await db
    .select()
    .from(dbSchema.stripeSupportClaims)
    .where(eq(dbSchema.stripeSupportClaims.id, claimId))
    .limit(1);
  return claim ?? null;
}

/** A paid one-off: ledger the session, then add tag time. No Stripe call, so one transaction. */
async function creditOneOffSession(
  claim: SupportClaim,
  session: Stripe.Checkout.Session,
  currency: SupportClaimCurrency,
): Promise<void> {
  await db.transaction(
    async (tx) => {
      if (!(await lockSupportAccount(tx, claim.userId))) return;
      const recorded = await recordSessionOnce(tx, {
        userId: claim.userId,
        session,
        cadence: 'one_time',
        currency,
        claim,
      });
      if (!recorded) return;
      await applyOneOffCredit(tx, {
        userId: claim.userId,
        amountMinor: session.amount_total ?? 0,
        currency,
        customerId: stripeId(session.customer),
        now: new Date(),
      });
    },
    { isolationLevel: 'read committed' },
  );
}

/** A monthly Payment Link: read the subscription back from Stripe and link it. */
async function linkCheckoutSubscription(
  claim: SupportClaim,
  session: Stripe.Checkout.Session,
  currency: SupportClaimCurrency,
  eventCreated: number,
): Promise<void> {
  const subscriptionId = stripeId(session.subscription);
  if (!subscriptionId) {
    logger.warn('[stripe-webhook] subscription checkout without a subscription', { sessionId: session.id });
    return;
  }
  await withSupportOperation(
    claim.userId,
    'accepting',
    async () => null,
    async () => getStripeClient().subscriptions.retrieve(subscriptionId),
    async (tx, _prepared, subscription) => {
      await recordSessionOnce(tx, { userId: claim.userId, session, cadence: 'monthly', currency, claim });
      await linkSubscription(tx, {
        userId: claim.userId,
        subscription,
        eventCreatedAt: new Date(eventCreated * 1000),
      });
    },
  );
}

/**
 * checkout.session.completed and checkout.session.async_payment_succeeded.
 * Only a `client_reference_id` that starts with `sc_` links to an account;
 * anything else is the page's `src` tag and the payment stays anonymous.
 */
export async function acceptCheckoutSession(session: Stripe.Checkout.Session, eventCreated: number): Promise<void> {
  const claimId = supportClaimIdFrom(session.client_reference_id);
  if (!claimId) {
    logger.info('[stripe-webhook] checkout without an account claim; nothing to link', {
      sessionId: session.id,
      mode: session.mode,
    });
    return;
  }
  const currency = supportedCurrency(session.currency);
  if (!currency) {
    logger.warn('[stripe-webhook] ignored checkout in an unsupported currency', {
      sessionId: session.id,
      currency: session.currency,
    });
    return;
  }
  const claim = await loadClaim(claimId);
  if (!claim) {
    logger.warn('[stripe-webhook] checkout names an unknown claim', { sessionId: session.id });
    return;
  }

  if (session.mode === 'subscription') {
    await linkCheckoutSubscription(claim, session, currency, eventCreated);
    return;
  }
  if (session.mode !== 'payment') return;
  // Delayed methods complete unpaid; async_payment_succeeded brings them back paid.
  if (session.payment_status !== 'paid') {
    logger.info('[stripe-webhook] one-off checkout not paid yet', { sessionId: session.id });
    return;
  }
  await creditOneOffSession(claim, session, currency);
}

/**
 * customer.subscription.created/updated/deleted. Only a subscription already
 * linked to an account is touched, and its status is read back from Stripe so
 * events delivered out of order cannot store a stale one.
 */
export async function syncSubscription(subscription: Stripe.Subscription, eventCreated: number): Promise<void> {
  const [linkedSupporter] = await db
    .select({ userId: dbSchema.stripeSupporters.userId })
    .from(dbSchema.stripeSupporters)
    .where(eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id))
    .limit(1);
  if (!linkedSupporter) return;
  await withSupportOperation(
    linkedSupporter.userId,
    'subscription',
    async (transaction) => {
      const [current] = await transaction
        .select()
        .from(dbSchema.stripeSupporters)
        .where(eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id))
        .limit(1);
      return current ?? null;
    },
    async (current) => (current ? getStripeClient().subscriptions.retrieve(subscription.id) : null),
    async (transaction, current, latestSubscription) => {
      if (!current || !latestSubscription) return;
      const eventCreatedAt = new Date(eventCreated * 1000);
      await transaction
        .update(dbSchema.stripeSupporters)
        .set({
          subscriptionStatus: latestSubscription.status,
          cancelAtPeriodEnd: latestSubscription.cancel_at_period_end,
          stripeCustomerId: stripeId(latestSubscription.customer),
          stripeEventCreatedAt:
            current.stripeEventCreatedAt && current.stripeEventCreatedAt > eventCreatedAt
              ? current.stripeEventCreatedAt
              : eventCreatedAt,
          updatedAt: new Date(),
        })
        .where(eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id));
    },
  );
}

/** Route one verified event. Exported for tests; the HTTP handler is the only production caller. */
export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await acceptCheckoutSession(event.data.object, event.created);
      return;
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      // Nothing was recorded for an unpaid session, so there is nothing to undo.
      // An unused claim stays until createSupportClaim prunes it.
      logger.info('[stripe-webhook] checkout ended without payment', {
        sessionId: event.data.object.id,
        eventType: event.type,
      });
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(event.data.object, event.created);
      return;
    default:
      return;
  }
}

/**
 * POST /webhooks/stripe. Fails closed: without STRIPE_SECRET_KEY and
 * STRIPE_WEBHOOK_SECRET it answers 503 and touches nothing, so Stripe keeps
 * retrying until the backend is configured.
 */
export async function handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret || !isStripeWebhookConfigured()) {
    sendJson(res, 503, { error: 'Stripe webhook is not configured' });
    return;
  }
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string' || !signature) {
    sendJson(res, 400, { error: 'Missing Stripe signature' });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_STRIPE_WEBHOOK_BYTES);
  } catch (error) {
    logger.warn('[stripe-webhook] unreadable request body', { error });
    sendJson(res, 413, { error: 'Request body too large' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    logger.warn('[stripe-webhook] signature verification failed', { error });
    sendJson(res, 400, { error: 'Invalid Stripe webhook' });
    return;
  }

  try {
    await processStripeEvent(event);
  } catch (error) {
    // A 500 makes Stripe retry; every path above is idempotent per session.
    logger.error('[stripe-webhook] event processing failed', { eventId: event.id, eventType: event.type, error });
    sendJson(res, 500, { error: 'Stripe webhook processing failed' });
    return;
  }
  sendJson(res, 200, { received: true });
}
