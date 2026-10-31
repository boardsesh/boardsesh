import { z } from 'zod';

/**
 * The runtime env contract behind the buttons on `/support`.
 *
 * Every link and every button label comes from the Railway web service's own
 * environment, read per request by the server component. None is a
 * `NEXT_PUBLIC_` name: those are inlined at build time, and neither
 * `Dockerfile.web` nor `production-deploy.yml` passes one as a build arg, so a
 * prefixed var could never be set in production at all.
 *
 * Amounts live in Stripe and in the labels Marco types into the env. They never
 * go in this repo, the i18n catalogs, or an analytics event.
 *
 * | Var                          | Shape                                  |
 * | ---------------------------- | -------------------------------------- |
 * | `SUPPORT_MONTHLY_LINKS_AUD`  | JSON array of `{ "label", "url" }`     |
 * | `SUPPORT_MONTHLY_LINKS_USD`  | JSON array of `{ "label", "url" }`     |
 * | `STRIPE_DONATE_URL`          | one-off Payment Link, AUD              |
 * | `STRIPE_DONATE_URL_USD`      | one-off Payment Link, USD              |
 * | `STRIPE_BILLING_PORTAL_URL`  | Stripe customer-portal login link      |
 *
 * A value that fails its check is treated as unset, so a typo hides a button
 * instead of pointing it somewhere else. A monthly list is all or nothing: one
 * bad entry drops the whole list. Full contract: docs/production-deploy.md.
 */

export const SUPPORT_CURRENCIES = ['aud', 'usd'] as const;
export type SupportCurrency = (typeof SUPPORT_CURRENCIES)[number];

/** Hosts a Stripe Payment Link is served from. `donate.` is Stripe's donation variant. */
const PAYMENT_LINK_HOSTS: ReadonlySet<string> = new Set(['buy.stripe.com', 'donate.stripe.com']);
/** Host of the customer-portal login link that lets a monthly supporter change or stop. */
const BILLING_PORTAL_HOSTS: ReadonlySet<string> = new Set(['billing.stripe.com']);

export const MAX_MONTHLY_OPTIONS = 6;
export const MAX_SUPPORT_LABEL_LENGTH = 40;

/** What `?src=` falls back to when the page was opened without a usable one. */
export const DEFAULT_SUPPORT_SRC = 'web-support';
const MAX_SUPPORT_SRC_LENGTH = 40;

export type SupportLink = { label: string; url: string };

/** An `https://` URL on one of `hosts`, with no credentials or port. Anything else is unset. */
export function parseStripeUrl(
  rawValue: string | undefined,
  hosts: ReadonlySet<string> = PAYMENT_LINK_HOSTS,
): string | undefined {
  if (!rawValue) return undefined;
  let url: URL;
  try {
    url = new URL(rawValue.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (!hosts.has(url.hostname)) return undefined;
  return url.toString();
}

const monthlyLinkSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(MAX_SUPPORT_LABEL_LENGTH),
      url: z.string(),
    }),
  )
  .min(1)
  .max(MAX_MONTHLY_OPTIONS);

/**
 * One currency's monthly list. Undefined when the var is unset, is not JSON, has
 * the wrong shape, or carries any URL that is not a Stripe Payment Link.
 */
export function parseMonthlyLinks(rawValue: string | undefined): SupportLink[] | undefined {
  if (!rawValue?.trim()) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(rawValue);
  } catch {
    return undefined;
  }
  const parsed = monthlyLinkSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const links: SupportLink[] = [];
  for (const entry of parsed.data) {
    const url = parseStripeUrl(entry.url);
    if (!url) return undefined;
    links.push({ label: entry.label, url });
  }
  return links;
}

export type SupportLinksConfig = {
  monthly: Record<SupportCurrency, SupportLink[] | undefined>;
  once: Record<SupportCurrency, string | undefined>;
  billingPortalUrl: string | undefined;
};

/** `process.env`, or a plain object in tests. The names read are in the table at the top. */
type SupportEnv = Readonly<Record<string, string | undefined>>;

export function readSupportLinksConfig(env: SupportEnv = process.env): SupportLinksConfig {
  return {
    monthly: {
      aud: parseMonthlyLinks(env.SUPPORT_MONTHLY_LINKS_AUD),
      usd: parseMonthlyLinks(env.SUPPORT_MONTHLY_LINKS_USD),
    },
    once: {
      aud: parseStripeUrl(env.STRIPE_DONATE_URL),
      usd: parseStripeUrl(env.STRIPE_DONATE_URL_USD),
    },
    billingPortalUrl: parseStripeUrl(env.STRIPE_BILLING_PORTAL_URL, BILLING_PORTAL_HOSTS),
  };
}

/** True when any currency has a monthly list. Without one the page renders as it did before monthly. */
export function hasMonthlyLinks(config: SupportLinksConfig): boolean {
  return SUPPORT_CURRENCIES.some((currency) => (config.monthly[currency]?.length ?? 0) > 0);
}

/**
 * `?src=` as a Stripe-safe tag: lowercase `[a-z0-9-]`, at most 40 characters.
 * Stripe's `client_reference_id` allows letters, digits, `-` and `_`; the
 * narrower set keeps the value readable in a CSV and in PostHog.
 */
export function sanitizeSupportSrc(rawValue: string | string[] | undefined): string {
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const cleaned = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_SUPPORT_SRC_LENGTH)
    .replace(/^-+|-+$/g, '');
  return cleaned || DEFAULT_SUPPORT_SRC;
}

/** The link with `client_reference_id` and `utm_source` set to `src`, replacing any already there. */
export function withSupportSource(url: string, src: string): string {
  const tagged = new URL(url);
  tagged.searchParams.set('client_reference_id', src);
  tagged.searchParams.set('utm_source', src);
  return tagged.toString();
}

/** What `createSupportClaim` returns: `sc_` plus 32 hex (docs/supporters.md). */
const SUPPORT_CLAIM_ID_PATTERN = /^sc_[0-9a-f]{32}$/;

/**
 * The link for a signed-in climber: the claim id in `client_reference_id` (the
 * webhook links the payment through it), `utm_source` still the page tag, and
 * the account's email prefilled so a later claim by email finds it too.
 * Throws on anything that is not a claim id, so a caller falls back to
 * `withSupportSource` instead of sending a stray value to Stripe.
 */
export function withSupportClaim(
  url: string,
  { claimId, src, email }: { claimId: string; src: string; email?: string | null },
): string {
  if (!SUPPORT_CLAIM_ID_PATTERN.test(claimId)) throw new Error('not a support claim id');
  const tagged = new URL(url);
  tagged.searchParams.set('client_reference_id', claimId);
  tagged.searchParams.set('utm_source', src);
  const prefilledEmail = email?.trim();
  if (prefilledEmail) tagged.searchParams.set('prefilled_email', prefilledEmail);
  else tagged.searchParams.delete('prefilled_email');
  return tagged.toString();
}

/** The server route every Stripe button goes through (`app/support/go/route.ts`). */
export const SUPPORT_GO_PATH = '/support/go';

export type SupportCadence = 'monthly' | 'once';

/**
 * A button's name for its Payment Link, so the page never hands the browser a
 * raw URL to bounce through: `monthly-aud-2` is the second AUD tier (1-based),
 * `once-usd` the USD one-off link.
 */
export function supportLinkKey(cadence: SupportCadence, currency: SupportCurrency, option = 1): string {
  return cadence === 'monthly' ? `monthly-${currency}-${option}` : `once-${currency}`;
}

export type ResolvedSupportLink = { url: string; cadence: SupportCadence; currency: SupportCurrency };

const SUPPORT_LINK_KEY_PATTERN = /^(monthly|once)-(aud|usd)(?:-([1-9][0-9]?))?$/;

/**
 * The configured Payment Link a key names, or undefined. This is the only way
 * `/support/go` picks a destination, so it can never redirect anywhere the env
 * did not list.
 */
export function resolveSupportLinkKey(
  config: SupportLinksConfig,
  rawKey: string | null | undefined,
): ResolvedSupportLink | undefined {
  const match = SUPPORT_LINK_KEY_PATTERN.exec(rawKey ?? '');
  if (!match) return undefined;
  const cadence: SupportCadence = match[1] === 'monthly' ? 'monthly' : 'once';
  const currency = parseCurrencyParam(match[2]);
  if (!currency) return undefined;
  if (cadence === 'once') {
    if (match[3] !== undefined) return undefined;
    const url = config.once[currency];
    return url ? { url, cadence, currency } : undefined;
  }
  if (match[3] === undefined) return undefined;
  const url = config.monthly[currency]?.[Number(match[3]) - 1]?.url;
  return url ? { url, cadence, currency } : undefined;
}

/** The button href for a key: `/support/go?link=<key>&src=<src>`. */
export function supportGoHref(key: string, src: string): string {
  const params = new URLSearchParams({ link: key, src });
  return `${SUPPORT_GO_PATH}?${params.toString()}`;
}

export function parseCurrencyParam(rawValue: string | string[] | undefined): SupportCurrency | undefined {
  const value = (Array.isArray(rawValue) ? rawValue[0] : rawValue)?.toLowerCase();
  return SUPPORT_CURRENCIES.find((currency) => currency === value);
}

/**
 * USD for a visitor Cloudflare places in the US, AUD for everyone else and for
 * anyone it cannot place. A currency with no link at all is skipped.
 */
export function defaultSupportCurrency(country: string | null, available: readonly SupportCurrency[]): SupportCurrency {
  const preferred: SupportCurrency = country === 'US' ? 'usd' : 'aud';
  return available.includes(preferred) ? preferred : (available[0] ?? preferred);
}

/**
 * What the client renders: finished hrefs and labels. Every Stripe href goes
 * through `/support/go`, which links a signed-in climber's payment to their
 * account and otherwise redirects with the `src` tag, as the page always did.
 */
export type SupportPageOptions = {
  monthly: Partial<Record<SupportCurrency, SupportLink[]>>;
  once: Partial<Record<SupportCurrency, string>>;
  currencies: SupportCurrency[];
  defaultCurrency: SupportCurrency;
  billingPortalUrl?: string;
  /** False renders the page as it was before monthly links existed. */
  monthlyFirst: boolean;
};

export function buildSupportPageOptions({
  config,
  src,
  country,
  currencyParam,
}: {
  config: SupportLinksConfig;
  src: string;
  country: string | null;
  currencyParam?: SupportCurrency;
}): SupportPageOptions {
  const monthly: SupportPageOptions['monthly'] = {};
  const once: SupportPageOptions['once'] = {};
  for (const currency of SUPPORT_CURRENCIES) {
    const monthlyLinks = config.monthly[currency];
    if (monthlyLinks?.length) {
      monthly[currency] = monthlyLinks.map((link, index) => ({
        label: link.label,
        url: supportGoHref(supportLinkKey('monthly', currency, index + 1), src),
      }));
    }
    if (config.once[currency]) once[currency] = supportGoHref(supportLinkKey('once', currency), src);
  }
  const currencies = SUPPORT_CURRENCIES.filter((currency) => monthly[currency] || once[currency]);
  const defaultCurrency =
    currencyParam && currencies.includes(currencyParam) ? currencyParam : defaultSupportCurrency(country, currencies);
  return {
    monthly,
    once,
    currencies,
    defaultCurrency,
    billingPortalUrl: config.billingPortalUrl,
    monthlyFirst: hasMonthlyLinks(config),
  };
}
