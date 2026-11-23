// The iOS Smart App Banner (#6027): what the root layout puts in the
// `apple-itunes-app` meta tag for one request, or nothing at all.
//
// Safari on an iPhone or iPad reads the tag and puts its own strip across the
// top of the page: "View" in the App Store for someone without the app, "Open"
// for someone with it. No other browser reads it.
//
// Pure, so the layout, a test and a reader get the same answer for a path.

import { localeHref } from './i18n/locale-href';
import type { Locale } from './i18n/config';
import { SITE_URL } from './seo/base-url';
import { appStoreCampaignToken, appStoreProviderId } from './store-links';
import { IOS_APP_STORE_ID } from './store-urls';

/** The meta tag's name. Safari looks for exactly this. */
export const SMART_APP_BANNER_META_NAME = 'apple-itunes-app';

/**
 * Pages that are a display or a widget, not a page someone reads on their own
 * phone. A gym leaves `/kiosk/...` open on a wall screen or an iPad all day,
 * where a banner is a permanent strip over the display and "Open" walks away
 * from it. `/embed/...` is rendered inside someone else's site. `/poster/...`
 * is a sheet someone is about to print: "Open" would leave the print page for
 * the app, which is the one place the poster cannot be printed from.
 */
const NO_BANNER_PATH_PREFIXES = ['/kiosk', '/embed', '/poster'] as const;

/**
 * Pages whose query string is the whole point. `/auth/reset-password` is
 * `?token=&email=`, and the app's own reset screen treats a link without them
 * as invalid. The banner still offers the app there; "Open" just opens it,
 * instead of handing it a URL that cannot work.
 */
const NO_ARGUMENT_PATH_PREFIXES = ['/auth'] as const;

function isUnder(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The tag's `content` for a request, or `null` for a page that gets no banner.
 *
 * `pathname` is the one middleware forwards: locale prefix stripped, no query
 * string. `null` is a request no middleware saw, which gets the banner with no
 * argument.
 *
 *  - `app-id` names the app.
 *  - `affiliate-data` carries the campaign link params Apple reads from a
 *    banner: `ct=site-banner`, and `pt` when the build has a provider id. The
 *    same token a store button would carry, so the banner's downloads show up
 *    in App Analytics under their own campaign.
 *  - `app-argument` is the URL "Open" hands the app, so the climber lands on the
 *    climb they were reading. Pathname only: several of these pages are served
 *    from a shared CDN cache, and one visitor's query string (a campaign tag, a
 *    reset token) must not be written into HTML the next visitor is handed.
 */
export function smartAppBannerContent(pathname: string | null, locale: Locale): string | null {
  if (pathname && isUnder(pathname, NO_BANNER_PATH_PREFIXES)) return null;

  const campaign = new URLSearchParams();
  const providerId = appStoreProviderId();
  if (providerId) campaign.set('pt', providerId);
  campaign.set('ct', appStoreCampaignToken({ placement: 'site-banner' }));

  const parts = [`app-id=${IOS_APP_STORE_ID}`, `affiliate-data=${campaign.toString()}`];
  if (pathname && !isUnder(pathname, NO_ARGUMENT_PATH_PREFIXES)) {
    parts.push(`app-argument=${SITE_URL}${localeHref(pathname, locale)}`);
  }
  return parts.join(', ');
}

/**
 * iOS browsers that are not Safari, and in-app browsers, by the token each puts
 * in its user agent. None of them reads the `apple-itunes-app` tag. Chrome,
 * Firefox, Edge and Opera on iOS run WebKit and still say `Safari/`, so the
 * token is the only way to tell them apart; an in-app browser (Instagram,
 * Facebook, the Google app) is a web view that never shows Safari's banner.
 */
const NOT_SAFARI_TOKENS =
  /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo\/|Ddg\/|FBAN|FBAV|FBIOS|Instagram|Line\/|Snapchat|TikTok|musical_ly|LinkedInApp|Pinterest|Twitter/i;

/**
 * Whether Safari's own Smart App Banner shows for this browser: Safari on an
 * iPhone, iPod or iPad, and nowhere else. A page that offers its own install
 * bar asks this first, so an iPhone reader never gets two.
 *
 * `maxTouchPoints` tells an iPad from a Mac: iPadOS Safari asks for desktop
 * pages by default and says `Macintosh`, like a Mac, which shows no banner.
 *
 * A user agent can lie, and Brave on iOS sends Safari's exactly. Both errors are
 * cheap: the reader gets either Safari's banner or ours, never a broken page.
 */
export function smartAppBannerShows(userAgent: string, maxTouchPoints = 0): boolean {
  const appleMobile = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  if (!appleMobile) return false;
  const safari = /Version\/\d/.test(userAgent) && /Safari\//.test(userAgent);
  return safari && !NOT_SAFARI_TOKENS.test(userAgent);
}
