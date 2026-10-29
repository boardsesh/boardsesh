/**
 * When the homepage's December support banner may show.
 *
 * 1 to 31 December 2026 inclusive, in UTC: from 2026-12-01T00:00:00Z up to but
 * not including 2027-01-01T00:00:00Z. UTC rather than Sydney time because the
 * page is served to every timezone and the server and the browser must agree
 * without knowing where the visitor is. In Sydney that is 11 am on 1 Dec to
 * 11 am on 1 Jan; in New York, 7 pm on 30 Nov to 7 pm on 31 Dec.
 *
 * The server renders nothing outside the window, and the browser checks again
 * with its own clock, so a page held in any cache past 31 Dec shows nothing.
 */
export const SUPPORT_BANNER_STARTS_AT = Date.UTC(2026, 11, 1);
export const SUPPORT_BANNER_ENDS_BEFORE = Date.UTC(2027, 0, 1);

export function isSupportBannerWindow(now: Date): boolean {
  const time = now.getTime();
  return time >= SUPPORT_BANNER_STARTS_AT && time < SUPPORT_BANNER_ENDS_BEFORE;
}

/** Where the banner goes. `src` tags the Stripe link and the click event. */
export const SUPPORT_BANNER_HREF = '/support?src=web-home-banner';

/**
 * The IndexedDB preference that hides it after a close. Named for this
 * campaign, so a later banner starts visible for everyone.
 */
export const SUPPORT_BANNER_DISMISSED_KEY = 'supportBanner:december2026:dismissed';
