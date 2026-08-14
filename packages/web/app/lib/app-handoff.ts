import { APP_URL } from '@/app/lib/app-origin';
import { DEFAULT_LOCALE, type Locale } from '@/app/lib/i18n/config';
import { stripLocalePrefix } from '@/app/lib/i18n/locale-href';

/**
 * The app.boardsesh.com twin of a www pathname: `APP_URL` plus the same path,
 * with the locale prefix stripped.
 *
 * The Expo app has no `/es`, `/fr` or `/de` routing, so a Spanish reader
 * following the "Climb this" CTA lands on the English app — an accepted
 * regression recorded in the reposition epic, not an oversight here.
 *
 * No query string is accepted on purpose: the front door's CTA contract is
 * "same pathname on the app origin", and a filter/sort param on www means
 * nothing to the SPA route it opens.
 */
export function buildAppHandoffUrl(pathname: string, locale: Locale = DEFAULT_LOCALE): string {
  const withoutLocale = stripLocalePrefix(pathname, locale);
  const path = withoutLocale.startsWith('/') ? withoutLocale : `/${withoutLocale}`;
  return `${APP_URL.replace(/\/+$/, '')}${path}`;
}
