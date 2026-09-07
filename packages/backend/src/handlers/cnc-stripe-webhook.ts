import type { IncomingMessage, ServerResponse } from 'http';
import type Stripe from 'stripe';
import type { CncOrder } from '@boardsesh/db/schema';
import { readJsonBody, sendJson } from './http-utils';
import { logger } from '../utils/logger';
import { constructWebhookEvent, isStripeWebhookConfigured } from '../services/cnc/stripe';
import { claimStripeEvent, markStripeEventProcessed, releaseStripeEvent } from '../services/cnc/stripe-events';
import {
  getAccountEmail,
  getOrderById,
  getOrderByPaymentIntentId,
  transitionOrder,
  type CncOrdersExecutor,
} from '../services/cnc/orders';
import { db } from '../db/client';
import { releaseArtAssetsForOrder } from '../services/cnc/art-assets';
import { CNC_KICKER_SET_IDS, describeBoard, parseSetIds } from '../services/cnc/catalog';
import { sendCncOrderReceivedEmail } from '../email/cnc-emails';
import { webPublicUrl } from '../utils/public-urls';
import { captureBackendEvent } from '../services/analytics/posthog';

/**
 * POST /api/cnc/stripe/webhook
 *
 * The only path by which a build-pack order becomes paid. No CORS, no bearer
 * token: the `stripe-signature` header over the raw body IS the authentication,
 * and it is the only thing that is trusted here. The body is never logged — it
 * carries the buyer's email and the full charge record.
 *
 * Status codes are a contract with Stripe's retry machinery, so they are
 * deliberately narrow:
 *
 * - **400** only for a body that did not come from Stripe (bad or missing
 *   signature, oversized payload). Stripe does not usefully retry these, and
 *   nothing else should ever produce one.
 * - **500** only when the database would not answer. That is the one failure
 *   worth a redelivery, and answering 200 to it would lose a paid order.
 * - **200** for everything else, including event types we ignore, sessions that
 *   were not actually paid, orders we cannot resolve, and redeliveries. An
 *   event we have decided not to act on is handled, not failed; leaving it to
 *   retry for three days would bury the deliveries that matter.
 *
 * Idempotency is a uniqueness constraint, not application logic: the event id
 * is inserted into `cnc_stripe_events` before any side effect, and a second
 * delivery of the same id loses that race and no-ops.
 *
 * The claim insert commits on its own — a failed handler hands it back with
 * `releaseStripeEvent` so Stripe's retry is not eaten as a duplicate — but the
 * order transition and the "processed" stamp share one transaction. Marking an
 * event processed after a transition that then rolled back would leave a paid
 * order in `pending_payment` and tell every redelivery there was nothing to do.
 */

/** 1 MB. Stripe's largest events are a few tens of KB; anything near this is not from Stripe. */
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/** What one event did, so the event row can record which order it moved. */
type WebhookOutcome = {
  /** The order this event resolved to, or null when it was ignored. */
  orderId: number | null;
  /**
   * Set only when this delivery is the one that actually moved the order to
   * `queued`. A redelivery, or a completion for an order someone else already
   * queued, leaves it null — which is what stops the buyer being emailed twice
   * and the purchase being counted twice.
   */
  queued: CncOrder | null;
  /**
   * The GST-exclusive equivalent of `queued.amountCents`, from the session's
   * `total_details.amount_tax` when Stripe reported one. `amountCents` itself
   * stays what Stripe actually charged (GST-inclusive) — this is analytics-only
   * and is never persisted on the order row.
   */
  amountExcludingTaxCents?: number | null;
};

const IGNORED: WebhookOutcome = { orderId: null, queued: null };

/** The Stripe id off a field that is either an id or the expanded object. */
function idOf(reference: string | { id: string } | null | undefined): string | null {
  if (!reference) return null;
  return typeof reference === 'string' ? reference : reference.id;
}

/**
 * Find the order a Checkout Session belongs to.
 *
 * Both metadata fields are required, and the licence id is cross-checked
 * against the row rather than trusted. The metadata comes back from Stripe, so
 * it is only as trustworthy as the signature that carried it — but a session
 * created against the wrong order (a bad deploy, a hand-crafted test event
 * signed with a leaked secret) would otherwise queue somebody else's pack.
 * Mismatch is ignored, loudly.
 */
async function resolveSessionOrder(
  session: Stripe.Checkout.Session,
  eventType: string,
  tx: CncOrdersExecutor,
): Promise<CncOrder | null> {
  const rawOrderId = session.metadata?.orderId;
  const licenceId = session.metadata?.licenceId;
  const orderId = Number(rawOrderId);

  if (!rawOrderId || !Number.isSafeInteger(orderId) || orderId <= 0) {
    logger.warn('[cnc-webhook] session carried no usable orderId metadata', { eventType, sessionId: session.id });
    return null;
  }

  const order = await getOrderById(orderId, tx);
  if (!order) {
    logger.warn('[cnc-webhook] no order for the session metadata', { eventType, orderId, sessionId: session.id });
    return null;
  }

  if (!licenceId || order.licenceId !== licenceId) {
    logger.error('[cnc-webhook] session licenceId does not match the order; ignoring', {
      eventType,
      orderId,
      sessionId: session.id,
    });
    return null;
  }

  return order;
}

/**
 * Payment confirmed: queue the pack.
 *
 * Handles both `checkout.session.completed` and
 * `checkout.session.async_payment_succeeded` identically — the latter is the
 * delayed-payment method (e.g. a bank debit) actually clearing, and by the
 * time it fires the session's own `payment_status` already reads `paid`, so
 * the same transition and the same "what did Stripe actually charge" logic
 * apply unchanged.
 *
 * `payment_status` is checked rather than assumed. `checkout.session.completed`
 * fires for delayed-payment methods too, where the session is complete but the
 * money is not there yet — queueing on that would generate a licensed pack for
 * a payment that can still fail. That case is what `async_payment_succeeded`
 * (money arrived) and `async_payment_failed` (it didn't — see
 * {@link handleCheckoutExpired}) resolve.
 *
 * The amount and currency are taken from Stripe, not from the catalogue price
 * we wrote at checkout: with Stripe Tax on, what was actually charged is
 * Stripe's number, and the order should record what the buyer paid.
 */
async function handleCheckoutCompleted(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  tx: CncOrdersExecutor,
): Promise<WebhookOutcome> {
  if (session.payment_status !== 'paid') {
    logger.info('[cnc-webhook] checkout completed without payment; not queueing', {
      sessionId: session.id,
      paymentStatus: session.payment_status,
    });
    return IGNORED;
  }

  const order = await resolveSessionOrder(session, event.type, tx);
  if (!order) return IGNORED;

  // Stripe's own clock, not ours. A redelivery three days later must not stamp
  // the order as paid three days late.
  const paidAt = new Date(event.created * 1000);

  // GST-exclusive equivalent of the (GST-inclusive) amount stored on the order
  // — analytics-only, see `WebhookOutcome.amountExcludingTaxCents`.
  const amountExcludingTaxCents =
    session.amount_total != null && session.total_details?.amount_tax != null
      ? session.amount_total - session.total_details.amount_tax
      : null;

  const queued = await transitionOrder(
    order.id,
    'checkoutCompleted',
    {
      paidAt,
      queuedAt: paidAt,
      stripePaymentIntentId: idOf(session.payment_intent),
      amountCents: session.amount_total ?? order.amountCents,
      currency: session.currency ? session.currency.toUpperCase() : order.currency,
    },
    { executor: tx },
  );

  if (!queued) {
    // Zero rows: the order was not in `pending_payment` any more. A redelivery,
    // or a refund that beat the completion. Either way there is nothing to do
    // and nothing has gone wrong.
    logger.info('[cnc-webhook] order already moved on from pending_payment', {
      orderId: order.id,
      status: order.status,
    });
    return { orderId: order.id, queued: null };
  }

  return { orderId: order.id, queued, amountExcludingTaxCents };
}

/**
 * The checkout lapsed without payment. Retire the reserved order.
 *
 * Handles both `checkout.session.expired` (the 30-minute session ran out
 * unpaid) and `checkout.session.async_payment_failed` (a delayed-payment
 * method — the money was never going to arrive — declined). Both leave the
 * order exactly as unpaid as it already was, and `checkoutExpired` is the
 * transition the state table already allows from `pending_payment`, so
 * neither event needs one of its own.
 *
 * Uploaded artwork the checkout claimed goes back to the buyer here. Checkout
 * stamps `cnc_art_assets.order_id` before Stripe is asked for a session, and
 * an asset that still carries a dead order's id can never be attached again —
 * so an expired session would otherwise cost the buyer a re-upload to retry.
 */
async function handleCheckoutExpired(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  tx: CncOrdersExecutor,
): Promise<WebhookOutcome> {
  const order = await resolveSessionOrder(session, event.type, tx);
  if (!order) return IGNORED;

  await transitionOrder(order.id, 'checkoutExpired', {}, { executor: tx });
  // Best-effort and deliberately on the pooled connection rather than `tx`:
  // handing the artwork back must never abort the webhook's transaction.
  await releaseArtAssetsForOrder(order.id);
  return { orderId: order.id, queued: null };
}

/**
 * The charge was refunded. Downloads stop.
 *
 * A refund arrives as a charge with no session attached — the checkout may have
 * been months ago — so the payment intent is the only handle on the order. That
 * is why the completion above stores it.
 *
 * Partial refunds are treated the same as full ones: Boardsesh does not sell
 * part of a licence, so any money going back means the licence is not being
 * honoured any more.
 */
async function handleChargeRefunded(
  event: Stripe.Event,
  charge: Stripe.Charge,
  tx: CncOrdersExecutor,
): Promise<WebhookOutcome> {
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) {
    logger.warn('[cnc-webhook] refunded charge has no payment intent', { chargeId: charge.id });
    return IGNORED;
  }

  const order = await getOrderByPaymentIntentId(paymentIntentId, tx);
  if (!order) {
    // Every Stripe charge on the account lands here, including ones that have
    // nothing to do with build packs, so this is not necessarily a bug — but
    // it is worth a look, so warn rather than info. The payment intent id is
    // enough to check by hand in the Stripe dashboard; the body is never
    // logged (it carries the buyer's email and the full charge record).
    logger.warn("[cnc-webhook] no build-pack order for the refunded charge's payment intent", {
      paymentIntentId,
    });
    return IGNORED;
  }

  await transitionOrder(order.id, 'refund', { refundedAt: new Date(event.created * 1000) }, { executor: tx });
  return { orderId: order.id, queued: null };
}

async function processEvent(event: Stripe.Event, tx: CncOrdersExecutor): Promise<WebhookOutcome> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return handleCheckoutCompleted(event, event.data.object, tx);
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      return handleCheckoutExpired(event, event.data.object, tx);
    case 'charge.refunded':
      return handleChargeRefunded(event, event.data.object, tx);
    default:
      // Subscribed types are configured in the Stripe dashboard, so anything
      // else here is a dashboard change nobody told the code about. Recorded
      // and acknowledged, never retried.
      logger.info('[cnc-webhook] ignoring event type', { type: event.type });
      return IGNORED;
  }
}

/**
 * Tell the buyer and PostHog about a purchase.
 *
 * Runs only for the delivery that actually queued the order, and only after the
 * event is marked processed — a failure here must not turn a completed payment
 * into a 500 that Stripe redelivers, because the redelivery would find the
 * order already queued and never retry the email anyway.
 *
 * The "order received" mail goes to the signed-in account's own email and,
 * when `licenseeEmail` names someone else (a teammate, a client, whoever the
 * wall is actually for), to that address too. Each send is independently
 * best-effort — `sendCncOrderReceivedEmail` already logs and swallows its own
 * failures — so a dead address on one side never costs the other its receipt.
 */
async function announcePurchase(order: CncOrder, amountExcludingTaxCents: number | null): Promise<void> {
  const boardLabel = describeBoard(order);
  const setIds = parseSetIds(order.setIds) ?? [];
  const hasKicker = setIds.some((setId) => CNC_KICKER_SET_IDS.includes(setId));

  // The account is nullable (the licence outlives it — `set null` on account
  // deletion), so there may be nothing to look up.
  const accountEmail = order.userId ? await getAccountEmail(order.userId) : null;
  // Never null on this path: `tier` is nullable only before finalise, and this
  // runs on a paid order. Narrowed rather than asserted so a genuinely
  // tier-less order skips the receipt instead of mailing "undefined licence".
  const { tier } = order;
  if (!tier) {
    logger.error('[cnc-webhook] a paid order has no licence tier; skipping the receipt', {
      orderId: order.id,
      licenceId: order.licenceId,
    });
    return;
  }
  const recipients = new Set<string>();
  if (accountEmail) recipients.add(accountEmail);
  if (order.licenseeEmail) recipients.add(order.licenseeEmail);

  for (const to of recipients) {
    await sendCncOrderReceivedEmail({
      to,
      licenseeName: order.licenseeName ?? 'there',
      licenceId: order.licenceId,
      boardLabel,
      tier,
      orderUrl: `${webPublicUrl()}/build-plans/orders/${encodeURIComponent(order.licenceId)}`,
    });
  }

  captureBackendEvent('Build Plans Pack Purchased', {
    // The account is nullable (the licence outlives it), so the licence id is
    // the fallback identity — a purchase with no distinct id would be dropped.
    distinctId: order.userId ?? order.licenceId,
    properties: {
      tier,
      board_name: order.boardName,
      layout_id: order.layoutId,
      size_id: order.sizeId,
      kicker: hasKicker,
      has_artwork: Array.isArray(order.artwork) && order.artwork.length > 0,
      // GST-inclusive: what Stripe actually charged. See the doc comment on
      // `Build Plans Pack Purchased` above for why this is not the catalogue
      // price.
      amount_cents: order.amountCents,
      // GST-exclusive equivalent, when Stripe reported a tax breakdown. Null
      // for an order with no tax details (e.g. a jurisdiction Stripe Tax
      // didn't charge GST in) rather than derived from a guessed rate.
      amount_excluding_tax_cents: amountExcludingTaxCents,
      currency: order.currency,
    },
  });
}

export async function handleCncStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Unmounted rather than broken when Stripe is not configured, matching
  // `apns-stats.ts`. A 404 tells an operator wiring up the endpoint that the
  // env is missing; a 500 would look like our problem, and a 200 would look
  // like it worked.
  if (!isStripeWebhookConfigured()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  let rawBody: string;
  try {
    // `readJsonBody` reads JSON bodies; it does not parse them. It returns the
    // RAW utf-8 string, and that is exactly what is wanted here: the signature
    // is computed over these bytes, so a `JSON.parse` + `JSON.stringify` round
    // trip — key order, whitespace, number formatting — would break
    // verification in a way that looks for all the world like a wrong secret.
    // Do not "tidy" this into a parsed object; `constructWebhookEvent` does
    // the parsing, after it has verified the string.
    rawBody = await readJsonBody(req, MAX_WEBHOOK_BODY_BYTES);
  } catch {
    sendJson(res, 400, { error: 'Invalid request body' });
    return;
  }

  const signatureHeader = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader);
  } catch {
    // Already logged (without the body) inside constructWebhookEvent.
    sendJson(res, 400, { error: 'Invalid signature' });
    return;
  }

  let claimed: boolean;
  try {
    claimed = await claimStripeEvent(event.id, event.type);
  } catch (error) {
    logger.error('[cnc-webhook] could not record the event; asking Stripe to retry', { eventId: event.id, error });
    sendJson(res, 500, { error: 'Event could not be recorded' });
    return;
  }

  if (!claimed) {
    sendJson(res, 200, { received: true, duplicate: true });
    return;
  }

  let outcome: WebhookOutcome;
  try {
    // One transaction, so the order transition and the stamp that says this
    // event will never be acted on again land together or not at all.
    outcome = await db.transaction(async (tx) => {
      const processed = await processEvent(event, tx);
      await markStripeEventProcessed(event.id, processed.orderId, tx);
      return processed;
    });
  } catch (error) {
    logger.error('[cnc-webhook] handler failed; releasing the claim so Stripe can retry', {
      eventId: event.id,
      type: event.type,
      error,
    });
    // Without this the retry would see the claim row and no-op, leaving a paid
    // order stuck in `pending_payment` with no further deliveries able to fix
    // it. A process KILLED mid-handler never reaches here, and the row it
    // leaves with a null `processed_at` is the intended "started and died"
    // trace.
    try {
      await releaseStripeEvent(event.id);
    } catch (releaseError) {
      logger.error('[cnc-webhook] could not release the event claim', { eventId: event.id, releaseError });
    }
    sendJson(res, 500, { error: 'Event handling failed' });
    return;
  }

  // Answer Stripe first. The email and the analytics event are best-effort
  // consequences of a payment that is already durable in the order row.
  sendJson(res, 200, { received: true });

  if (outcome.queued) {
    try {
      await announcePurchase(outcome.queued, outcome.amountExcludingTaxCents ?? null);
    } catch (error) {
      logger.warn('[cnc-webhook] purchase announcement failed', { orderId: outcome.queued.id, error });
    }
  }
}
