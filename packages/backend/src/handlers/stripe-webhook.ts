import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { readJsonBody, sendJson } from './http-utils';
import {
  getStripeClient,
  stripeId,
  SUPPORT_CURRENCY,
  SUPPORT_MAXIMUM_AMOUNT,
  SUPPORT_MINIMUM_AMOUNT,
} from '../services/stripe-support';
import { logger } from '../utils/logger';

const MAX_WEBHOOK_BYTES = 256 * 1024;

async function acceptCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const claimId = session.client_reference_id;
  if (!claimId || session.payment_status !== 'paid') return;
  if (
    session.currency !== SUPPORT_CURRENCY ||
    session.amount_total == null ||
    session.amount_total < SUPPORT_MINIMUM_AMOUNT ||
    session.amount_total > SUPPORT_MAXIMUM_AMOUNT
  ) {
    logger.warn('[stripe-webhook] rejected checkout with unexpected amount or currency', { sessionId: session.id });
    return;
  }

  await db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(dbSchema.stripeSupportClaims)
      .where(
        and(
          eq(dbSchema.stripeSupportClaims.id, claimId),
          eq(dbSchema.stripeSupportClaims.checkoutSessionId, session.id),
        ),
      )
      .limit(1);
    if (!claim || claim.completedAt) return;

    const stripeCustomerId = stripeId(session.customer);
    const stripeSubscriptionId =
      typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null);
    const [existingSupporter] = await tx
      .select()
      .from(dbSchema.stripeSupporters)
      .where(eq(dbSchema.stripeSupporters.userId, claim.userId))
      .limit(1);
    const retainedSubscriptionId = stripeSubscriptionId ?? existingSupporter?.stripeSubscriptionId ?? null;
    const retainedSubscriptionStatus = stripeSubscriptionId
      ? 'active'
      : (existingSupporter?.subscriptionStatus ?? null);
    const now = new Date();
    await tx
      .insert(dbSchema.stripeSupporters)
      .values({
        userId: claim.userId,
        stripeCustomerId,
        stripeSubscriptionId: retainedSubscriptionId,
        subscriptionStatus: retainedSubscriptionStatus,
        showPublicly: claim.showPublicly,
        supportedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: dbSchema.stripeSupporters.userId,
        set: {
          stripeCustomerId,
          stripeSubscriptionId: retainedSubscriptionId,
          subscriptionStatus: retainedSubscriptionStatus,
          showPublicly: claim.showPublicly,
          supportedAt: now,
          updatedAt: now,
        },
      });
    await tx
      .update(dbSchema.stripeSupportClaims)
      .set({ completedAt: now })
      .where(eq(dbSchema.stripeSupportClaims.id, claim.id));
  });
}

async function updateSubscription(subscription: Stripe.Subscription): Promise<void> {
  await db
    .update(dbSchema.stripeSupporters)
    .set({
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      stripeCustomerId: stripeId(subscription.customer),
      updatedAt: new Date(),
    })
    .where(eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id));
}

export async function handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    sendJson(res, 503, { error: 'Stripe webhook is not configured' });
    return;
  }
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    sendJson(res, 400, { error: 'Missing Stripe signature' });
    return;
  }

  let event: Stripe.Event;
  try {
    const rawBody = await readJsonBody(req, MAX_WEBHOOK_BYTES);
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    logger.warn('[stripe-webhook] invalid request', { error });
    sendJson(res, 400, { error: 'Invalid Stripe webhook' });
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await acceptCheckout(event.data.object);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await updateSubscription(event.data.object);
      break;
    default:
      break;
  }
  sendJson(res, 200, { received: true });
}
