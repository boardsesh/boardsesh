/**
 * When the homepage's support banner may show.
 *
 * The first 7 days of every month, in UTC: from 00:00 on the 1st up to but not
 * including 00:00 on the 8th. UTC rather than Sydney time because the page is
 * served to every timezone and the server and the browser must agree without
 * knowing where the visitor is. In Sydney that is 10 or 11 am on the 1st to the
 * same time on the 8th; in New York, 7 or 8 pm on the last day of the month
 * before to the same time on the 7th.
 *
 * The server renders nothing outside the window, and the browser checks again
 * with its own clock, so a page held in any cache past the 7th shows nothing.
 */
export const SUPPORT_BANNER_LAST_DAY = 7;

export function isSupportBannerWindow(now: Date): boolean {
  return now.getUTCDate() <= SUPPORT_BANNER_LAST_DAY;
}

/** The UTC month `now` falls in, as `YYYY-MM`: what a close is remembered against. */
export function supportBannerMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Where the banner goes. `src` tags the Stripe link and the click event. */
export const SUPPORT_BANNER_HREF = '/support?src=web-home-banner';

/**
 * The IndexedDB preference holding the month (`YYYY-MM`) the visitor closed the
 * banner in. It stays closed for the rest of that month and comes back on the
 * 1st of the next.
 */
export const SUPPORT_BANNER_CLOSED_MONTH_KEY = 'supportBanner:closedMonth';

/**
 * The IndexedDB preference that hides it for good: set by the thank-you state
 * on `/support?thanks=1`, so someone who just gave is not asked again in this
 * browser.
 */
export const SUPPORT_BANNER_SUPPORTER_KEY = 'supportBanner:supporter';
