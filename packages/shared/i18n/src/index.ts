export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  LOCALE_HTML_LANG,
  LOCALE_OG,
  LOCALE_LABELS,
  ALL_NAMESPACES,
  MOBILE_NAMESPACES,
  isSupportedLocale,
  type Locale,
  type Namespace,
  type MobileNamespace,
} from './config';

export {
  isChineseTranslationLocale,
  getChineseTerminologyFormUrl,
  chineseTranslationOnboardingKey,
} from './chinese-translation';

// NB: `loadCatalog` is intentionally NOT re-exported here. It contains a dynamic
// `import()` that Metro (mobile) cannot parse. Web imports it directly from the
// '@boardsesh/i18n/catalog-loader' subpath so the mobile bundle never sees it.
