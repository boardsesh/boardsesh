import Stripe from 'stripe';

export const SUPPORT_MINIMUM_AMOUNT = 100;
export const SUPPORT_MAXIMUM_AMOUNT = 50_000;
export const SUPPORT_CURRENCY = 'usd';

let stripeClient: Stripe | null = null;

export function isStripeSupportConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export function isLiveStripeSubscription(status?: string | null): boolean {
  return Boolean(status && !['canceled', 'incomplete', 'incomplete_expired', 'paused', 'unpaid'].includes(status));
}

export function getStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('Stripe support is not configured');
  // The client intentionally lives for the process lifetime. Rotating the
  // secret therefore requires restarting the backend deployment.
  stripeClient ??= new Stripe(secretKey);
  return stripeClient;
}

export function getBoardseshBaseUrl(): string {
  return (process.env.BOARDSESH_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function supportReturnUrl(locale?: string | null): string {
  const localePrefix = locale && locale !== 'en-US' && ['es', 'fr', 'de'].includes(locale) ? `/${locale}` : '';
  return `${getBoardseshBaseUrl()}${localePrefix}/support`;
}

export function stripeId(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}
