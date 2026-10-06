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
 * from it. `/embed/...` is rendered inside someone else's site.
 */
const NO_BANNER_PATH_PREFIXES = ['/kiosk', '/embed'] as const;

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
