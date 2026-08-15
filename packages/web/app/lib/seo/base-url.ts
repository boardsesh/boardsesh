import { localeHref } from '@/app/lib/i18n/locale-href';
import type { Locale } from '@/app/lib/i18n/config';

export const SITE_URL = 'https://www.boardsesh.com';

export function absoluteUrl(path = '/'): string {
  // Canonical site URL has no trailing slash, so the homepage is just SITE_URL.
  // This matches the convention sitemap consumers (and our snapshot tests) expect.
  if (path === '' || path === '/') {
    return SITE_URL;
  }
  if (!path.startsWith('/')) {
    return `${SITE_URL}/${path}`;
  }
  return `${SITE_URL}${path}`;
}

/**
 * The absolute URL of `path` **on the locale the page is rendering**.
 *
 * `createPageMetadata` runs every canonical through `localeHref(path, locale)`,
 * so on `/es/...` the page's `<link rel="canonical">` is the `/es` URL. JSON-LD
 * built from a bare `absoluteUrl(path)` would name the en-US URL on that same
 * page — structured data contradicting the canonical beside it. Same call, same
 * string.
 */
export function absoluteLocaleUrl(path: string, locale: Locale): string {
  return absoluteUrl(localeHref(path, locale));
}
