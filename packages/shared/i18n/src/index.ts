export {
  WEB_LOCALES,
  APP_ONLY_LOCALES,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  LOCALE_HTML_LANG,
  LOCALE_OG,
  LOCALE_LABELS,
  ALL_NAMESPACES,
  MOBILE_NAMESPACES,
  isWebLocale,
  isSupportedLocale,
  type Locale,
  type WebLocale,
  type Namespace,
  type MobileNamespace,
} from './config';

// NB: `loadCatalog` is intentionally NOT re-exported here. It contains a dynamic
// `import()` that Metro (mobile) cannot parse. Web imports it directly from the
// '@boardsesh/i18n/catalog-loader' subpath so the mobile bundle never sees it.
