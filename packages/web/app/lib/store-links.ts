// The one builder for every store link on www (#6027).
//
// Before this module only the gym page's Play link said where it came from, and
// it said `utm_medium=qr` for every click whether or not a code was scanned.
// The home hero and /help pointed at bare store URLs, which is where the
// "(not set)" Android installs come from, and no App Store link carried a
// campaign token at all.
//
// Every store button now goes through `buildStoreUrl`. Pure and synchronous, so
// a server component, a client island and a test get the same string.
//
// WHAT A LINK SAYS
//
//   source    `boardsesh`, or the visitor's own `utm_source` when they arrived
//             on a tagged link
//   medium    `web` for a click on a page, `qr` when the page was reached by
//             scanning a printed code, or the visitor's own `utm_medium`
//             (except `organic` and `(not set)`, which Play reserves)
//   campaign  `www`, `gym-<slug>` on a gym page, the caller's own campaign, or
//             the visitor's own `utm_campaign`
//   content   the LINK ID: which button was pressed. Always ours, never the
//             visitor's, so "which placement" survives a tagged visit.
//
// Google Play gets all four, in `referrer` (the string the app reads back) and
// as bare `utm_*` params. The App Store has room for one campaign token, `ct`.

import type { GymQrMedium } from '@boardsesh/analytics';
import type { AppInstallPlacement } from './app-install-event';
import type { InboundCampaign } from './inbound-campaign';
import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from './store-urls';

/** The two stores a www button can point at. */
export type StoreLinkStore = 'ios' | 'android';

/** `utm_source` of a link nobody tagged before the visitor reached us. */
export const STORE_LINK_SOURCE = 'boardsesh';

/** `utm_medium` of a store button pressed on a page the visitor browsed to. */
export const STORE_LINK_MEDIUM_WEB = 'web';

/**
 * `utm_medium` of a store button on a page reached by scanning a printed code
 * (`?src=qr&medium=…`). Until #6027 every gym-page link carried this value, so
 * `qr` installs before that change are gym-page clicks of any kind.
 */
export const STORE_LINK_MEDIUM_QR = 'qr';

/** `utm_campaign` of a link with no gym, no caller campaign and no inbound one. */
export const STORE_LINK_DEFAULT_CAMPAIGN = 'www';

/** What a bare Google Ads click id stands for when the landing URL has no `utm_source`. */
export const GOOGLE_ADS_SOURCE = 'google';
export const GOOGLE_ADS_MEDIUM = 'cpc';

/**
 * Mediums a store link never takes from the visitor, compared lowercased.
 *
 * Play writes `utm_medium=organic` itself for an install from a store search,
 * and `(not set)` when it has no referrer, and the app reads them that way:
 * `classifyInstallChannel` in `packages/mobile/src/lib/install-referrer.ts`
 * files ANY referrer whose medium is `organic` as an organic install before it
 * looks at the source or the campaign. A gym that tags its Google Business
 * Profile link `utm_medium=organic` would otherwise turn every install from our
 * button into a Play organic one, on every binary already shipped.
 */
const RESERVED_PLAY_MEDIUMS: ReadonlySet<string> = new Set(['organic', '(not set)']);

/** Apple's limit on the `ct` campaign token. */
export const APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH = 30;

/** `mt=8` is Apple's media type for an app; campaign links carry it next to `pt` and `ct`. */
const APP_STORE_MEDIA_TYPE = '8';

export type StoreLinkInput = {
  /** Which button this is. Becomes the link id, and must match the `placement` on its `App Install Click`. */
  placement: AppInstallPlacement;
  /**
   * The CANONICAL slug of the gym page the button is on. Names the campaign
   * `gym-<slug>`, the string gym installs have always reported.
   */
  gymSlug?: string;
  /**
   * A campaign of the caller's own, for a surface that is about one thing (a
   * session invite, say). Wins over `gymSlug`, loses to the visitor's own
   * `utm_campaign`.
   */
  campaign?: string;
  /**
   * The printed medium the page was reached through, from `parseGymQrLanding`.
   * `null` or absent for a visit that did not come off a code.
   */
  qrMedium?: GymQrMedium | null;
  /**
   * The campaign the visitor arrived with, from `useInboundCampaign()`. Leave it
   * out on the server: a cached page has to render the same link for everyone.
   */
  inbound?: InboundCampaign | null;
};

/** The four values a store link carries, after every default and override is applied. */
export type StoreLinkAttribution = {
  source: string;
  medium: string;
  campaign: string;
  /** The link id. `<placement>`, or `<placement>.<printed medium>` after a scan. */
  content: string;
  /** Whether the visitor's own tags set any of source, medium or campaign. */
  inboundTagged: boolean;
  /**
   * Whether the visitor's tags NAME where they came from: a source or a
   * campaign. A medium alone (`?utm_medium=social`) does not, and neither does
   * one we refused to carry.
   */
  inboundNamed: boolean;
};

/** `utm_campaign` value for one gym. `gym-` prefixed so campaigns from other surfaces stay distinguishable. */
export function gymInstallCampaign(gymSlug: string): string {
  return `gym-${gymSlug}`;
}

/**
 * The link id: which button, and after a scan, which kind of printed code.
 * `gym-page` for a click on a gym page, `gym-page.poster` when that page was
 * reached from a poster.
 */
export function storeLinkId(placement: AppInstallPlacement, qrMedium?: GymQrMedium | null): string {
  return qrMedium ? `${placement}.${qrMedium}` : placement;
}

/**
 * Work out what a store link should say.
 *
 * The visitor's own tags win FIELD BY FIELD, not all or nothing: a gym that
 * links its page from Instagram with `?utm_source=instagram&utm_medium=social`
 * and no campaign still reports `gym-<slug>`, because nothing replaced it.
 *
 * A landing URL with a `gclid` and no `utm_source` is a Google Ads click, so it
 * reads as `google` / `cpc` instead of falling back to `boardsesh`. The click id
 * itself is not copied into the link.
 *
 * One medium is never taken from the visitor: `organic` (any case), or Play's
 * own `(not set)`. See `RESERVED_PLAY_MEDIUMS`. Ours stays in its place, and the
 * visitor's source and campaign still carry through.
 */
export function resolveStoreLinkAttribution(input: StoreLinkInput): StoreLinkAttribution {
  const inbound = input.inbound ?? null;
  const isBareAdsClick = Boolean(inbound?.gclid) && !inbound?.utm_source;

  const inboundSource = inbound?.utm_source ?? (isBareAdsClick ? GOOGLE_ADS_SOURCE : undefined);
  const taggedMedium =
    inbound?.utm_medium && !RESERVED_PLAY_MEDIUMS.has(inbound.utm_medium.toLowerCase())
      ? inbound.utm_medium
      : undefined;
  const inboundMedium = taggedMedium ?? (isBareAdsClick ? GOOGLE_ADS_MEDIUM : undefined);
  const inboundCampaign = inbound?.utm_campaign;

  const ownMedium = input.qrMedium ? STORE_LINK_MEDIUM_QR : STORE_LINK_MEDIUM_WEB;
  const ownCampaign =
    input.campaign || (input.gymSlug ? gymInstallCampaign(input.gymSlug) : STORE_LINK_DEFAULT_CAMPAIGN);

  return {
    source: inboundSource ?? STORE_LINK_SOURCE,
    medium: inboundMedium ?? ownMedium,
    campaign: inboundCampaign ?? ownCampaign,
    content: storeLinkId(input.placement, input.qrMedium),
    inboundTagged: inboundSource !== undefined || inboundMedium !== undefined || inboundCampaign !== undefined,
    inboundNamed: inboundSource !== undefined || inboundCampaign !== undefined,
  };
}

/**
 * The Google Play URL for a store button.
 *
 * It sets `referrer` AND the bare `utm_*` params, and `referrer` is the one
 * that does the work. Play populates the Install Referrer API from the
 * **`referrer` query parameter** of the store URL, and
 * `packages/mobile/src/lib/install-referrer.ts` reads that string back with
 * `new URLSearchParams(raw)`. So `referrer` carries a nested, percent-encoded
 * copy of the same params; a link with only the bare ones reads fine to a human
 * and attributes zero installs, because the app never sees them.
 *
 * The app parses `utm_source`, `utm_medium` and `utm_campaign` into person
 * properties and keeps the whole string as `install_referrer_raw`, which is
 * where the link id (`utm_content`) is read from. No app change is needed for it.
 */
export function buildPlayStoreUrl(input: StoreLinkInput): string {
  const { source, medium, campaign, content } = resolveStoreLinkAttribution(input);
  // The value Play hands the app verbatim; the mobile parser splits it as a
  // query string, so it is built as one and then encoded once as a param value.
  const referrer = new URLSearchParams({
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign,
    utm_content: content,
  });

  const url = new URL(ANDROID_PLAY_STORE_URL);
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaign);
  url.searchParams.set('utm_content', content);
  url.searchParams.set('referrer', referrer.toString());
  return url.toString();
}

/**
 * The App Store Connect provider id that `pt` carries, or `null` when the build
 * has none. Read from `NEXT_PUBLIC_APP_STORE_PROVIDER_ID`, digits only.
 *
 * App Analytics only attributes a campaign link that names its provider, so
 * until the variable is set the `ct` token rides along unread. See
 * `docs/growth-metrics.md`.
 */
export function appStoreProviderId(): string | null {
  const providerId = process.env.NEXT_PUBLIC_APP_STORE_PROVIDER_ID?.trim();
  return providerId && /^\d+$/.test(providerId) ? providerId : null;
}

/** Reduce a string to what a campaign token may hold: letters, digits, `.`, `_`, `-`, at most 30 characters. */
function toCampaignToken(rawToken: string): string {
  return rawToken
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, APP_STORE_CAMPAIGN_TOKEN_MAX_LENGTH)
    .replace(/-+$/, '');
}

/**
 * The `ct` campaign token for an App Store link.
 *
 * One token is all Apple gives, and App Analytics hides a campaign until it has
 * at least 5 first-time downloads, so the token stays coarse:
 *
 *  - a visitor whose link named a source or a campaign reports that:
 *    `<source>-<campaign>`, or `<source>` when it named no campaign;
 *  - everyone else reports the link id (`hero`, `gym-page`, `gym-page.poster`).
 *    That includes a link tagged with a medium and nothing else: the source
 *    would be our own `boardsesh` on every button, which names neither the
 *    visitor's origin nor the placement.
 *
 * A single gym never appears here. `gym-<slug>` would use the 30 characters and
 * no one gym reaches 5 downloads from its page.
 */
export function appStoreCampaignToken(input: StoreLinkInput): string {
  const attribution = resolveStoreLinkAttribution(input);
  if (!attribution.inboundNamed) return toCampaignToken(attribution.content);

  const inboundName = input.inbound?.utm_campaign
    ? `${attribution.source}-${attribution.campaign}`
    : attribution.source;
  return toCampaignToken(inboundName) || toCampaignToken(attribution.content);
}

/**
 * The App Store URL for a store button: `pt` (provider, when configured), `ct`
 * (campaign token) and `mt=8`.
 *
 * Apple has no install referrer, so this is aggregate only. App Analytics
 * counts downloads per `ct`; nothing reaches the app or PostHog.
 */
export function buildAppStoreUrl(input: StoreLinkInput): string {
  const url = new URL(IOS_APP_STORE_URL);
  const providerId = appStoreProviderId();
  if (providerId) url.searchParams.set('pt', providerId);
  url.searchParams.set('ct', appStoreCampaignToken(input));
  url.searchParams.set('mt', APP_STORE_MEDIA_TYPE);
  return url.toString();
}

/** The store URL for a button, by store. The one function a store button should call. */
export function buildStoreUrl(store: StoreLinkStore, input: StoreLinkInput): string {
  return store === 'android' ? buildPlayStoreUrl(input) : buildAppStoreUrl(input);
}
