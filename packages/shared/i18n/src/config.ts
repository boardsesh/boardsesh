/**
 * Locales www serves. Everything web-shaped derives from this list: the
 * `/<locale>/…` routes in the middleware, sitemap entries, hreflang alternates,
 * the language switcher, and the Cloudflare cache-rule prefixes
 * (`scripts/cloudflare-apply.test.ts` pins that list to this one).
 *
 * Add a locale here only when all of `ALL_NAMESPACES` is translated for it. A
 * web locale with a missing namespace file falls back to English at runtime, so
 * the page would publish English copy under a foreign hreflang and sitemap URL.
 */
export const WEB_LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
export type WebLocale = (typeof WEB_LOCALES)[number];

/**
 * Locales only the mobile app renders. They ship `MOBILE_NAMESPACES` catalogs
 * and nothing else, so they must stay out of `WEB_LOCALES`: www has no
 * `/zh-Hans` route, sitemap row or hreflang.
 */
export const APP_ONLY_LOCALES = ['zh-Hans'] as const;

/**
 * Every locale the mobile app can run in: the web locales plus the app-only
 * ones. Web code must not read this list. It imports `WEB_LOCALES` (the web
 * config module re-exports it under its old name).
 */
export const SUPPORTED_LOCALES = [...WEB_LOCALES, ...APP_ONLY_LOCALES] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// Typed as a web locale: English is served by both surfaces, and web code
// compares and assigns it against its own narrower `Locale`.
export const DEFAULT_LOCALE: WebLocale = 'en-US';
export const DEFAULT_NAMESPACE = 'common';

export const LOCALE_HTML_LANG: Record<Locale, string> = {
  'en-US': 'en',
  es: 'es',
  fr: 'fr',
  de: 'de',
  'zh-Hans': 'zh-Hans',
};

export const LOCALE_OG: Record<Locale, string> = {
  'en-US': 'en_US',
  es: 'es_ES',
  fr: 'fr_FR',
  de: 'de_DE',
  'zh-Hans': 'zh_CN',
};

export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  'zh-Hans': '简体中文',
};

/**
 * Every namespace shipped in the locale catalogs. The catalog JSON files under
 * `locales/<locale>/<namespace>.json` mirror this list exactly.
 */
export const ALL_NAMESPACES = [
  'common',
  'marketing',
  'auth',
  'settings',
  'profile',
  'playlists',
  'climbs',
  'session',
  'notifications',
  'feed',
  'you',
  'admin',
  'aurora',
  'boards',
  'kiosk',
  'gyms',
] as const;
export type Namespace = (typeof ALL_NAMESPACES)[number];

/**
 * Namespaces available in the mobile app. Web-only namespaces (`marketing`,
 * `admin`, `gyms`) are excluded so Metro never bundles them.
 */
export const MOBILE_NAMESPACES = [
  'common',
  'auth',
  'climbs',
  'session',
  'profile',
  'settings',
  'playlists',
  'notifications',
  'feed',
  'you',
  'boards',
  'aurora',
] as const;
export type MobileNamespace = (typeof MOBILE_NAMESPACES)[number];

export function isWebLocale(value: string | undefined | null): value is WebLocale {
  return value != null && (WEB_LOCALES as readonly string[]).includes(value);
}

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
