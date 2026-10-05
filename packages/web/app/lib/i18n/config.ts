// Locale catalogs and shared locale config now live in @boardsesh/i18n so the
// mobile app can consume the exact same source. This module re-exports the
// shared config and keeps the web-only transport bits (header/cookie names,
// root namespaces) plus the `SeedNamespace` alias the web app references.
//
// `SUPPORTED_LOCALES`, `Locale` and `isSupportedLocale` here are the WEB list:
// the shared package also carries app-only locales (zh-Hans) that have no
// marketing/gyms/kiosk/admin catalogs, and www must not route, index or offer
// them. Web code imports locales from this module, never from '@boardsesh/i18n'.
export {
  WEB_LOCALES as SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  LOCALE_HTML_LANG,
  LOCALE_OG,
  LOCALE_LABELS,
  ALL_NAMESPACES as SEED_NAMESPACES,
  isWebLocale as isSupportedLocale,
  type WebLocale as Locale,
  type Namespace as SeedNamespace,
} from '@boardsesh/i18n';

export const ROOT_NAMESPACES = ['common'] as const;

export const LOCALE_HEADER = 'x-boardsesh-locale';
export const LOCALE_COOKIE = 'boardsesh-locale';
