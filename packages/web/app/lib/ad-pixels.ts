// Ad measurement on www: who may see the Meta Pixel and the Reddit Pixel.
//
// Pure decision logic only. The DOM side (script injection, page views, the
// Lead conversion, cookie cleanup) lives in `ad-pixels-browser.ts` and asks
// this module before it does anything. See docs/analytics-consent.md#ad-pixels.
//
// The rule, on top of the analytics consent the website already enforces:
//
//   1. A region default (analytics on by default outside the prompt regions,
//      never written in one) runs the pixels. The website never applies a
//      region default under Global Privacy Control.
//   2. An explicit Allow runs them only when it was given on the website
//      (`source: 'web'`) on or after AD_MEASUREMENT_COPY_SINCE, the day the
//      banner and Privacy choices started naming Meta and Reddit. An older
//      Allow, or one given in the app (whose prompt never names them), keeps
//      PostHog but gets no pixels.
//   3. Anything else is off: no answer, No thanks, an outdated record.
//   4. Global Privacy Control turns them off whatever the record says. GPC is
//      the browser saying "do not share for advertising", which is exactly what
//      a pixel does.
//
// Why rule 2 needs no region: a region default cannot exist in a prompt region
// (the browser drops it as soon as the lookup says "ask"), so the only "on" a
// prompt-region visitor can hold is an explicit Allow, and the date proves they
// saw the copy that names the pixels. Outside the prompt regions an explicit
// Allow passes the same test, which is stricter than needed and never wrong.

import {
  AD_MEASUREMENT_COPY_SINCE,
  isAnalyticsGranted,
  isRegionDefaultConsent,
  type ConsentRecord,
} from '@boardsesh/consent';
import { analyticsPathname, stripAnalyticsLocalePrefix } from './analytics-paths';
import { isProductionHost } from './production-hosts';

const AD_MEASUREMENT_COPY_SINCE_MS = Date.parse(AD_MEASUREMENT_COPY_SINCE);

/**
 * Route trees that never load or fire a pixel, compared locale-stripped and
 * lowercased. `/oauth` is a partner app's sign-in and consent: its URLs carry
 * the app's signed authorization request. `/developers/apps` is the developer
 * console, which puts a new client secret on screen once.
 */
const EXCLUDED_PATH_PREFIXES = ['/kiosk', '/embed', '/auth', '/admin', '/oauth', '/developers/apps'] as const;

/** A Meta Pixel id is a plain number. Anything else is a misconfiguration and stays off. */
export function parseMetaPixelId(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim() ?? '';
  return /^\d{6,20}$/.test(trimmed) ? trimmed : null;
}

/** A Reddit Pixel id looks like `a2_abc123` or `t2_abc123`. */
export function parseRedditPixelId(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim() ?? '';
  return /^[A-Za-z0-9]{1,8}_[A-Za-z0-9]{1,40}$/.test(trimmed) ? trimmed : null;
}

/**
 * Does this consent record, on its own, allow ad measurement? Record-level
 * only: it ignores this page load's transient checks (account still
 * resolving, region not yet confirmed). False here is a definitive no, which
 * is when the browser module withdraws and clears the pixel cookies.
 */
export function isAdMeasurementPermitted(record: ConsentRecord | null, globalPrivacyControl: boolean): boolean {
  if (globalPrivacyControl) return false;
  if (record === null || !isAnalyticsGranted(record)) return false;
  if (isRegionDefaultConsent(record)) return true;
  if (record.source !== 'web') return false;
  const decidedAtMs = Date.parse(record.decidedAt);
  return Number.isFinite(decidedAtMs) && decidedAtMs >= AD_MEASUREMENT_COPY_SINCE_MS;
}

/** False for kiosk, embed, auth, admin and partner OAuth pages, in every locale and letter case. */
export function isAdPixelPath(pathnameOrUrl: string): boolean {
  // Lowercase first: the locale strip is case-sensitive, and /DE/auth must not slip through.
  const pathname = stripAnalyticsLocalePrefix(analyticsPathname(pathnameOrUrl).toLowerCase());
  return !EXCLUDED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export type AdPixelIds = {
  meta: string | null;
  reddit: string | null;
};

export type AdPixelInput = {
  /** Raw build-time ids, validated here. */
  metaPixelId: string | undefined;
  redditPixelId: string | undefined;
  /** The current `boardsesh-consent` record. */
  record: ConsentRecord | null;
  /**
   * This page load may act on that record: `hasAnalyticsConsent()`, which also
   * waits for the signed-in account to resolve and the region default to be
   * confirmed by this page load's lookup.
   */
  analyticsAuthorized: boolean;
  globalPrivacyControl: boolean;
  pathname: string;
  hostname: string;
};

const NO_PIXELS: AdPixelIds = { meta: null, reddit: null };

/** Which pixels may load and fire right now. Both null means do nothing at all. */
export function resolveAdPixels(input: AdPixelInput): AdPixelIds {
  const ids: AdPixelIds = {
    meta: parseMetaPixelId(input.metaPixelId),
    reddit: parseRedditPixelId(input.redditPixelId),
  };
  if (ids.meta === null && ids.reddit === null) return NO_PIXELS;
  if (!isProductionHost(input.hostname)) return NO_PIXELS;
  if (!input.analyticsAuthorized) return NO_PIXELS;
  if (!isAdMeasurementPermitted(input.record, input.globalPrivacyControl)) return NO_PIXELS;
  if (!isAdPixelPath(input.pathname)) return NO_PIXELS;
  return ids;
}
