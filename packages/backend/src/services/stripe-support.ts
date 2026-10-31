import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { SUPPORT_CLAIM_CURRENCIES, type SupportClaimCurrency } from '@boardsesh/db/schema';

let stripeClient: Stripe | null = null;
let stripeClientKey: string | null = null;

/** Claim ids carried to a Payment Link as `client_reference_id`. Anything else there is a `src` tag. */
export const SUPPORT_CLAIM_PREFIX = 'sc_';

export function newSupportClaimId(): string {
  return `${SUPPORT_CLAIM_PREFIX}${randomBytes(16).toString('hex')}`;
}

/** The claim id in a `client_reference_id`, or null when it is a `src` tag or empty. */
export function supportClaimIdFrom(clientReferenceId: string | null | undefined): string | null {
  return clientReferenceId?.startsWith(SUPPORT_CLAIM_PREFIX) ? clientReferenceId : null;
}

export function supportedCurrency(currency: string | null | undefined): SupportClaimCurrency | null {
  const normalized = currency?.toLowerCase();
  return SUPPORT_CLAIM_CURRENCIES.find((candidate) => candidate === normalized) ?? null;
}

/** Stripe API calls need the secret key. Without it every Stripe path fails closed. */
export function isStripeSupportConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** The webhook needs both: the key to read Stripe back, the secret to verify signatures. */
export function isStripeWebhookConfigured(): boolean {
  return isStripeSupportConfigured() && Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim());
}

export function getStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('Stripe support is not configured');
  // One client per key for the process lifetime; a rotated key builds a new one.
  if (!stripeClient || stripeClientKey !== secretKey) {
    stripeClient = new Stripe(secretKey, { timeout: 5_000, maxNetworkRetries: 1 });
    stripeClientKey = secretKey;
  }
  return stripeClient;
}

export function stripeId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}
