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
import { INBOUND_CAMPAIGN_PARAMS, parseInboundCampaign } from '@/app/lib/inbound-campaign';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { WALL_CAPABILITY_PARAM } from '@/app/lib/spray/spray-visibility';

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
 * The absolute URL a per-board QR encodes — the kiosk's install code, and the
 * printed board poster (`/poster/b/{slug}`, `medium=board`, #4415).
 *
 * `/b/{slug}` is not a gym page, so these scans never fire `Gym QR Scanned`.
 * `app/b/[board_slug]/page.tsx`'s redirect carries the params onto
 * `/b/{slug}/{angle}/list`, where `BoardQrLandingTracker` counts them as
 * `Board QR Scanned`. See "Which code fires which event" in
 * `docs/gym-funnel-analytics.md`.
 *
 * `wallUuid` is an UNLISTED spray wall's share-link capability. It goes first,
 * `?wall=<uuid>&src=qr&medium=board`, the same param `buildSprayWallShareUrl`
 * puts on the wall's share link (`packages/mobile/src/lib/spray/spray-share.ts`)
 * and the one `/b/{slug}` re-emits onto its redirect. Without it an unlisted
 * wall's code would scan to a 404. Leave it out for everything else: a public
 * wall and every LED board open on the plain slug, and a shorter URL is a
 * smaller code with bigger modules.
 */
export function boardQrUrl(boardSlug: string, medium: GymQrMedium, options: { wallUuid?: string } = {}): string {
  const boardPath = `/b/${encodeURIComponent(boardSlug)}`;
  const path = options.wallUuid
    ? `${boardPath}?${WALL_CAPABILITY_PARAM}=${encodeURIComponent(options.wallUuid)}`
    : boardPath;
  return absoluteUrl(buildGymQrHref(path, medium));
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
 * The query string a gym-page redirect carries to the canonical URL: the QR
 * pair from `gymQrAttributionQuery`, then the campaign params the visit landed
 * with (`utm_*`, `gclid`), or `''` when the request has neither (#6027).
 *
 * A gym's own bio link (`/gym/old-slug?utm_source=instagram&utm_medium=social`)
 * outlives a slug change the same way a poster does. The 308 used to drop
 * everything but the QR pair, so the visit reached the canonical page looking
 * like direct traffic: no `utm_source` on its `$pageview`, none on `App Install
 * Click`, and a store link that said `boardsesh` / `web`.
 *
 * Still an allowlist. Only the six names in `INBOUND_CAMPAIGN_PARAMS` come out,
 * each value trimmed and capped by `parseInboundCampaign` and re-encoded here,
 * so `?next=`, `?claim=` and anything else a crafted link carries is dropped as
 * before. Carrying the campaign params hands a crafted link nothing new: the
 * same params on the canonical URL are read by the page with no redirect
 * involved. A repeated param keeps its first value, as it does in the browser.
 */
export function gymRedirectAttributionQuery(searchParams: GymQrSearchParams): string {
  const requested = new URLSearchParams();
  for (const param of INBOUND_CAMPAIGN_PARAMS) {
    const requestedValue = searchParams[param];
    const firstValue = Array.isArray(requestedValue) ? requestedValue[0] : requestedValue;
    if (firstValue !== undefined) requested.set(param, firstValue);
  }
  const campaign = parseInboundCampaign(requested.toString());

  const redirectParams = new URLSearchParams(gymQrAttributionQuery(searchParams));
  for (const param of INBOUND_CAMPAIGN_PARAMS) {
    const campaignValue = campaign?.[param];
    if (campaignValue) redirectParams.set(param, campaignValue);
  }

  const query = redirectParams.toString();
  return query ? `?${query}` : '';
}
