// URL builders for per-gym QR and store-link attribution (#4379).
//
// The vocabulary — the param names, the `medium` union, the parser, and the
// `buildGymQrHref`/`stripGymQrParams` pair — lives in `@boardsesh/analytics`'s
// gym-funnel module and is imported here, never restated. This file adds only
// the www-specific URLs built on top of it: what a printed code encodes and what
// survives a redirect. Where a store link points, and what it says about a scan,
// is `store-links.ts`.
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
