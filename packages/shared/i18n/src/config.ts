export const SUPPORTED_LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-US';
export const DEFAULT_NAMESPACE = 'common';

export const LOCALE_HTML_LANG: Record<Locale, string> = {
  'en-US': 'en',
  es: 'es',
  fr: 'fr',
  de: 'de',
};

export const LOCALE_OG: Record<Locale, string> = {
  'en-US': 'en_US',
  es: 'es_ES',
  fr: 'fr_FR',
  de: 'de_DE',
};

export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
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
  'cnc',
  'cnc-legal',
] as const;
export type Namespace = (typeof ALL_NAMESPACES)[number];

/**
 * Namespaces available in the mobile app. Web-only namespaces (`marketing`,
 * `admin`, `gyms`, `cnc`) are excluded so Metro never bundles them.
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

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
