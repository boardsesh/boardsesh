// Locale catalogs and shared locale config now live in @boardsesh/i18n so the
// mobile app can consume the exact same source. This module re-exports the
// shared config and keeps the web-only transport bits (header/cookie names,
// root namespaces) plus the `SeedNamespace` alias the web app references.
export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  LOCALE_HTML_LANG,
  LOCALE_OG,
  LOCALE_LABELS,
  ALL_NAMESPACES as SEED_NAMESPACES,
  isSupportedLocale,
  type Locale,
  type Namespace as SeedNamespace,
} from '@boardsesh/i18n';

// Shared chrome and the sign-in dialog render outside page providers. Keep
// their catalogs here; page-specific catalogs belong to the route that uses them.
export const ROOT_NAMESPACES = ['common', 'consent', 'auth'] as const;

export const LOCALE_HEADER = 'x-boardsesh-locale';
export const LOCALE_COOKIE = 'boardsesh-locale';
