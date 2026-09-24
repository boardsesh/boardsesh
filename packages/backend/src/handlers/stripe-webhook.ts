import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type Stripe from 'stripe';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { readJsonBody, sendJson } from './http-utils';
import {
  getStripeClient,
  isStripeSupportConfigured,
  stripeId,
  SUPPORT_CURRENCY,
  SUPPORT_MAXIMUM_AMOUNT,
  SUPPORT_MINIMUM_AMOUNT,
} from '../services/stripe-support';
import { logger } from '../utils/logger';

const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function acceptCheckout(session: Stripe.Checkout.Session, eventCreated: number): Promise<void> {
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

  const stripeSubscriptionId =
    typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null);
  const subscription = stripeSubscriptionId
    ? await getStripeClient().subscriptions.retrieve(stripeSubscriptionId)
    : null;

  await db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(dbSchema.stripeSupportClaims)
      // The cryptographically random client_reference_id is embedded in the
      // Stripe-signed event and is authoritative. checkoutSessionId is only
      // bookkeeping because its post-create DB update can fail independently.
      .where(eq(dbSchema.stripeSupportClaims.id, claimId))
      .limit(1);
    if (!claim) return;

    const stripeCustomerId = stripeId(session.customer);
    const [existingSupporter] = await tx
      .select()
      .from(dbSchema.stripeSupporters)
      .where(eq(dbSchema.stripeSupporters.userId, claim.userId))
      .limit(1);
    const retainedSubscriptionId = stripeSubscriptionId ?? existingSupporter?.stripeSubscriptionId ?? null;
    const retainedSubscriptionStatus = subscription?.status ?? existingSupporter?.subscriptionStatus ?? null;
    const eventCreatedAt = new Date(eventCreated * 1000);
    const retainedEventCreatedAt = subscription
      ? existingSupporter?.stripeEventCreatedAt && existingSupporter.stripeEventCreatedAt > eventCreatedAt
        ? existingSupporter.stripeEventCreatedAt
        : eventCreatedAt
      : (existingSupporter?.stripeEventCreatedAt ?? null);
    const now = new Date();
    const supportedAt = existingSupporter?.supportedAt ?? now;
    await tx
      .insert(dbSchema.stripeSupporters)
      .values({
        userId: claim.userId,
        stripeCustomerId,
        stripeSubscriptionId: retainedSubscriptionId,
        subscriptionStatus: retainedSubscriptionStatus,
        stripeEventCreatedAt: retainedEventCreatedAt,
        cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? existingSupporter?.cancelAtPeriodEnd ?? false,
        showPublicly: claim.showPublicly,
        supportedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: dbSchema.stripeSupporters.userId,
        set: {
          stripeCustomerId,
          stripeSubscriptionId: retainedSubscriptionId,
          subscriptionStatus: retainedSubscriptionStatus,
          stripeEventCreatedAt: retainedEventCreatedAt,
          cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? existingSupporter?.cancelAtPeriodEnd ?? false,
          showPublicly: claim.showPublicly,
          supportedAt,
          updatedAt: now,
        },
      });
    // Removing the exact claim makes webhook retries a no-op and prevents
    // completed Checkout bindings from accumulating indefinitely.
    await tx.delete(dbSchema.stripeSupportClaims).where(eq(dbSchema.stripeSupportClaims.id, claim.id));
  });
}

export async function discardCheckout(session: Stripe.Checkout.Session): Promise<void> {
  if (!session.client_reference_id) return;
  await db.delete(dbSchema.stripeSupportClaims).where(eq(dbSchema.stripeSupportClaims.id, session.client_reference_id));
}

export async function updateSubscription(subscription: Stripe.Subscription, eventCreated: number): Promise<void> {
  const eventCreatedAt = new Date(eventCreated * 1000);
  const [current] = await db
    .select({ stripeEventCreatedAt: dbSchema.stripeSupporters.stripeEventCreatedAt })
    .from(dbSchema.stripeSupporters)
    .where(eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id))
    .limit(1);
  if (current?.stripeEventCreatedAt && current.stripeEventCreatedAt >= eventCreatedAt) return;

  await db
    .update(dbSchema.stripeSupporters)
    .set({
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      stripeCustomerId: stripeId(subscription.customer),
      stripeEventCreatedAt: eventCreatedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dbSchema.stripeSupporters.stripeSubscriptionId, subscription.id),
        or(
          isNull(dbSchema.stripeSupporters.stripeEventCreatedAt),
          lt(dbSchema.stripeSupporters.stripeEventCreatedAt, eventCreatedAt),
        ),
      ),
    );
}

export async function handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    sendJson(res, 503, { error: 'Stripe webhook is not configured' });
    return;
  }
  if (!isStripeSupportConfigured()) {
    sendJson(res, 503, { error: 'Stripe support is not configured' });
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

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await acceptCheckout(event.data.object, event.created);
        break;
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        await discardCheckout(event.data.object);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await updateSubscription(event.data.object, event.created);
        break;
      default:
        break;
    }
  } catch (error) {
    logger.error('[stripe-webhook] event processing failed', { eventId: event.id, eventType: event.type, error });
    sendJson(res, 500, { error: 'Stripe webhook processing failed' });
    return;
  }
  sendJson(res, 200, { received: true });
}
