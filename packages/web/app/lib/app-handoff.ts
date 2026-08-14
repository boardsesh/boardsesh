import { APP_URL } from '@/app/lib/app-origin';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { stripLocalePrefix } from '@/app/lib/i18n/locale-href';

/**
 * The app.boardsesh.com twin of a www pathname: `APP_URL` plus the same path,
 * with any locale prefix stripped.
 *
 * The Expo app has no `/es`, `/fr` or `/de` routing, so a Spanish reader
 * following the "Climb this" CTA lands on the English app — an accepted
 * regression recorded in the reposition epic, not an oversight here.
 *
 * Takes no locale argument on purpose. Every supported prefix is stripped, the
 * way `applyLocale` in `i18n/locale-href.ts` — the other half of this round
 * trip — already strips them; a caller that had to remember to thread the
 * active locale would silently hand out `app.boardsesh.com/es/…`, a route the
 * app does not have, on the day it forgot.
 *
 * `pathname` means pathname: a query string or fragment is dropped, because the
 * CTA contract is "the same pathname on the app origin" and a www filter or
 * sort param means nothing to the SPA route it opens.
 */
export function buildAppHandoffUrl(pathname: string): string {
  const [pathOnly] = pathname.split(/[?#]/);
  let withoutLocale = pathOnly;
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    withoutLocale = stripLocalePrefix(withoutLocale, locale);
  }
  const path = withoutLocale.startsWith('/') ? withoutLocale : `/${withoutLocale}`;
  return `${APP_URL.replace(/\/+$/, '')}${path}`;
}
