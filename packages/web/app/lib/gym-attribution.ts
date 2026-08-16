// URL builders for per-gym QR and store-link attribution (#4379).
//
// The vocabulary — the param names, the `medium` union, the parser, and the
// `buildGymQrHref`/`stripGymQrParams` pair — lives in `@boardsesh/analytics`'s
// gym-funnel module and is imported here, never restated. This file adds only
// the www-specific URLs built on top of it: what a printed code encodes, what
// survives a redirect, and where the Play Store link points.
//
// Everything here is pure and synchronous so a server component, a client
// island and a test all call the same function and get the same string. A QR
// that goes on a laminated poster cannot be patched after it is printed.

import {
  buildGymQrHref,
  parseGymQrLanding,
  GYM_QR_MEDIUM_PARAM,
  GYM_QR_SRC_PARAM,
  GYM_QR_SRC_VALUE,
  type GymQrMedium,
  type GymQrSearchParams,
} from '@boardsesh/analytics';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';

/**
 * The `utm_source` every Boardsesh-owned printed or on-wall surface reports.
 * One value across all of them: the interesting split is `utm_medium`
 * (which surface) and `utm_campaign` (which gym), not who owns the link.
 */
export const GYM_UTM_SOURCE = 'boardsesh';

/**
 * `utm_medium` for the store links reached from a gym page. `qr` rather than
 * `web`, because the traffic this measures arrives by scanning a code on the
 * wall — a QR poster scan is the acquisition path #4379 exists to count.
 */
export const GYM_UTM_MEDIUM = 'qr';

/** `utm_campaign` value for one gym. `gym-` prefixed so campaigns from other surfaces stay distinguishable. */
export function gymInstallCampaign(gymSlug: string): string {
  return `gym-${gymSlug}`;
}

/**
 * The absolute URL a printed gym QR encodes.
 *
 * Absolute, not a path: a phone camera needs a full URL, and a poster PDF has
 * no origin to resolve against. The slug is percent-encoded because it lands in
 * a path segment — gym slugs are generated lowercase-and-hyphens today, but this
 * string is printed and a slug rule that loosens later must not silently emit a
 * URL with a raw space or `#` in it.
 */
export function gymQrUrl(gymSlug: string, medium: GymQrMedium = 'poster'): string {
  return absoluteUrl(buildGymQrHref(`/gym/${encodeURIComponent(gymSlug)}`, medium));
}

/**
 * The absolute URL a per-board QR encodes — the kiosk's install code, and any
 * future code stuck to one wall.
 *
 * IMPORTANT and deliberate: `/b/{slug}` does NOT reach the QR landing tracker,
 * which only mounts on `/gym/[gym_slug]`. A `medium=kiosk` or `medium=board`
 * scan therefore cannot fire `Gym QR Scanned` — see the module comment on
 * `GYM_QR_MEDIUMS`. The params are still carried through
 * `app/b/[board_slug]/page.tsx`'s redirect so a first-party counter (#4387) or
 * a server log can attribute the visit, and so pointing one of these codes at a
 * gym page later is a one-line change rather than a reprint.
 */
export function boardQrUrl(boardSlug: string, medium: GymQrMedium): string {
  return absoluteUrl(buildGymQrHref(`/b/${encodeURIComponent(boardSlug)}`, medium));
}

/**
 * The QR attribution params, re-emitted as a query string, for a redirect that
 * would otherwise drop them — or `''` when the request carries no valid pair.
 *
 * STRICT ALLOWLIST, and that is the whole point. A redirect target built by
 * appending the caller's own search string would let anything a crafted link
 * carries ride through a 308 into a URL we published (`?medium=evil`,
 * `?utm_campaign=…`, a tracking param, a param the destination route reads).
 * Only `src` and `medium` come out, only after `parseGymQrLanding` has accepted
 * them, and the two values are then re-serialised from the contract's constants
 * and the parsed union member rather than copied out of the request. Nothing a
 * caller typed reaches the output string.
 *
 * Returns `''` — not `'?'` — when there is nothing to carry, so a plain visit
 * redirects to a clean URL with no dangling question mark.
 */
export function gymQrAttributionQuery(searchParams: GymQrSearchParams): string {
  const landing = parseGymQrLanding(searchParams);
  if (!landing) return '';
  const params = new URLSearchParams();
  params.set(GYM_QR_SRC_PARAM, GYM_QR_SRC_VALUE);
  params.set(GYM_QR_MEDIUM_PARAM, landing.medium);
  return `?${params.toString()}`;
}

/**
 * The Google Play URL a gym page's Android install button points at.
 *
 * It sets `referrer` AND the bare `utm_*` params, and the `referrer` is the one
 * that actually does the work. Play populates the Install Referrer API from the
 * **`referrer` query parameter** of the store URL, and
 * `packages/mobile/src/lib/install-referrer.ts` reads that string back with
 * `new URLSearchParams(raw)` to pull `utm_source`, `utm_medium` and
 * `utm_campaign` out of it. So `referrer` carries a nested, percent-encoded
 * copy of the same three params — a link with only the bare `utm_*` params
 * reads fine to a human, satisfies #4379's literal wording, and produces zero
 * attributed installs, because the mobile parser never sees them.
 *
 * The bare `utm_*` params stay because the Play web console's acquisition
 * reports read those, and they cost nothing.
 *
 * iOS is untouched: the App Store link keeps its existing URL. Apple has no
 * install-referrer equivalent here and iOS attribution is out of scope (#3402).
 */
export function playStoreUrlForGym(gymSlug: string): string {
  const campaign = gymInstallCampaign(gymSlug);
  // The value Play hands the app verbatim; the mobile parser splits it as a
  // query string, so it is built as one and then encoded once as a param value.
  const referrer = new URLSearchParams({
    utm_source: GYM_UTM_SOURCE,
    utm_medium: GYM_UTM_MEDIUM,
    utm_campaign: campaign,
  });

  const url = new URL(ANDROID_PLAY_STORE_URL);
  url.searchParams.set('utm_source', GYM_UTM_SOURCE);
  url.searchParams.set('utm_medium', GYM_UTM_MEDIUM);
  url.searchParams.set('utm_campaign', campaign);
  url.searchParams.set('referrer', referrer.toString());
  return url.toString();
}
