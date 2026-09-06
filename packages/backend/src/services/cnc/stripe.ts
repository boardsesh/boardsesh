import Stripe from 'stripe';
import { logger } from '../../utils/logger';
import { webPublicUrl } from '../../utils/public-urls';
import type { CncTierPrice } from './catalog';

/**
 * Stripe Checkout for CNC build packs.
 *
 * Everything money-shaped lives behind this module: the SDK client, the one
 * Checkout Session shape we create, and webhook signature verification. Two
 * rules hold here.
 *
 * 1. **Prices are never in the repo.** The catalogue names an env var
 *    (`stripePriceEnv`) and Stripe holds the amount. A price change is a
 *    dashboard action, not a deploy, and the catalogue's `priceCents` is only
 *    ever display copy of what Stripe will actually charge.
 * 2. **Fail closed.** An unconfigured Stripe is a checkout that is refused
 *    with a clear error, never one that silently succeeds without a payment.
 *    `isStripeConfigured()` is read at call time so the backend can boot in a
 *    dev stack that has no Stripe keys at all.
 */

/** Stripe is unreachable, misconfigured, or rejected the session we asked for. */
export class CncStripeUnavailableError extends Error {
  constructor(
    message: string,
    /** What actually went wrong, for the log. Never surfaced to the buyer. */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CncStripeUnavailableError';
  }
}

/** The `stripe-signature` header did not verify against `STRIPE_WEBHOOK_SECRET`. */
export class CncStripeSignatureError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CncStripeSignatureError';
  }
}

let stripeClient: Stripe | null = null;

/**
 * True when the secret key is set, i.e. when a Checkout Session can be created.
 *
 * Read from `process.env` on every call rather than captured at module load:
 * tests set and unset the key between cases, and a captured value would make
 * "is Stripe on" a property of import order.
 */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * True when incoming webhooks can be verified.
 *
 * Separate from {@link isStripeConfigured} because the two halves fail
 * independently: a deploy with a secret key but no webhook secret can sell a
 * pack and then never learn it was paid for. The webhook route 404s on this,
 * so a misconfigured endpoint looks unmounted to Stripe rather than silently
 * accepting unverified bodies.
 */
export function isStripeWebhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

/**
 * The lazily constructed SDK client.
 *
 * Lazy on purpose: constructing it at import time would make every test file
 * that pulls in a CNC module need Stripe env vars, and would move a
 * misconfiguration from "the one request that needed it fails" to "the backend
 * does not boot".
 *
 * No explicit `apiVersion`: the pinned `stripe` package already targets one
 * API version, so pinning it a second time here is a second place to forget on
 * an SDK upgrade.
 */
export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new CncStripeUnavailableError('STRIPE_SECRET_KEY is not set');
  }

  stripeClient = new Stripe(secretKey);
  return stripeClient;
}

/** Drop the memoised client. Tests use this; nothing in production does. */
export function resetStripeClientForTests(): void {
  stripeClient = null;
}

/**
 * How long a Checkout Session stays open.
 *
 * Stripe's floor is 30 minutes and it measures against its own clock when the
 * request lands, so sending exactly `now + 30 min` is rejected the moment
 * network latency or clock skew eats a second of it. The extra minute is that
 * cushion, not a product decision.
 */
const CHECKOUT_EXPIRY_MS = 31 * 60 * 1000;

/** What the buyer ticks before they can pay. The link is the licence they are agreeing to. */
function termsAcceptanceMessage(): string {
  return `I accept the Boardsesh manufacturing licence for this build (one wall). Terms: ${webPublicUrl()}/build-plans/licence`;
}

export type CreateCheckoutSessionForOrderInput = {
  /** The `pending_payment` row this session pays for. Both ids ride in the session metadata. */
  order: { id: number; licenceId: string };
  /** The catalogue's tier price, which names the env var holding the Stripe Price id. */
  tier: CncTierPrice;
  successUrl: string;
  cancelUrl: string;
  customerEmail: string;
};

export type CncCheckoutSessionResult = {
  sessionId: string;
  url: string;
};

/**
 * Open a Checkout Session for one order.
 *
 * The order row exists before this runs and stays `pending_payment` until the
 * webhook says otherwise — creating a session is not a payment, and nothing
 * here queues generation.
 *
 * Three fields carry the order back to us, deliberately redundantly:
 * `metadata.orderId` is what the webhook looks the row up by,
 * `metadata.licenceId` is what it cross-checks so a replayed or hand-crafted
 * session cannot point at someone else's order, and `client_reference_id` is
 * the licence id again for the Stripe dashboard, where support actually looks.
 * The same metadata is copied onto the PaymentIntent so a refund — which
 * arrives as a charge, with no session in sight — is still traceable by eye.
 */
export async function createCheckoutSessionForOrder({
  order,
  tier,
  successUrl,
  cancelUrl,
  customerEmail,
}: CreateCheckoutSessionForOrderInput): Promise<CncCheckoutSessionResult> {
  const priceId = process.env[tier.stripePriceEnv];
  if (!priceId) {
    throw new CncStripeUnavailableError(`${tier.stripePriceEnv} is not set, so the ${tier.tier} tier cannot be sold`);
  }

  const metadata = { orderId: String(order.id), licenceId: order.licenceId };

  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail,
      client_reference_id: order.licenceId,
      metadata,
      payment_intent_data: { metadata },
      // The licence is the product. Stripe collects the acceptance and stamps
      // it on the session, so "did they agree to these terms" is answered by
      // the payment record rather than by a checkbox we drew ourselves.
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: termsAcceptanceMessage() } },
      // Australian GST. Stripe Tax works out the rate and collects the address
      // it needs; getting this wrong is a tax problem, not a UX one.
      automatic_tax: { enabled: true },
      expires_at: Math.floor((Date.now() + CHECKOUT_EXPIRY_MS) / 1000),
      // No discount box. There are no promotions, and an empty field on a
      // A$750 licence only invites people to go looking for one.
      allow_promotion_codes: false,
    });
  } catch (error) {
    logger.error('[cnc-stripe] failed to create a Checkout Session', {
      orderId: order.id,
      tier: tier.tier,
      error: error instanceof Error ? error.message : error,
    });
    throw new CncStripeUnavailableError('Stripe would not open a checkout session', error);
  }

  if (!session.url) {
    // Only happens for a session created in a mode that has no hosted page.
    // Treated as an outage rather than ignored: without a URL there is nothing
    // to send the buyer to, and the order must not be left looking sold.
    logger.error('[cnc-stripe] Checkout Session came back without a hosted URL', {
      orderId: order.id,
      sessionId: session.id,
    });
    throw new CncStripeUnavailableError('Stripe returned a checkout session with no URL');
  }

  return { sessionId: session.id, url: session.url };
}

/**
 * Verify a webhook body and parse it into an event.
 *
 * `rawBody` must be the bytes exactly as Stripe sent them — the signature is
 * over the raw payload, so anything that re-serialises the JSON first (a body
 * parser, a `JSON.parse`/`stringify` round trip) breaks verification for
 * reasons that look like a wrong secret.
 *
 * Every failure is one error: an invalid signature, a stale timestamp and an
 * unparseable body are all "this did not come from Stripe" as far as the route
 * is concerned, and all answer 400.
 */
export function constructWebhookEvent(rawBody: string, signatureHeader: string | undefined): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new CncStripeUnavailableError('STRIPE_WEBHOOK_SECRET is not set');
  }
  if (!signatureHeader) {
    throw new CncStripeSignatureError('Missing stripe-signature header');
  }

  try {
    return getStripe().webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
  } catch (error) {
    // Deliberately does not log the body: a webhook payload carries the
    // buyer's email and the full charge record.
    logger.warn('[cnc-stripe] webhook signature verification failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw new CncStripeSignatureError('Webhook signature verification failed', error);
  }
}
