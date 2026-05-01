export const SUPPORTED_LOCALES = ['en-US', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-US';

export const LOCALE_HTML_LANG: Record<Locale, string> = {
  'en-US': 'en',
  es: 'es',
};

export const LOCALE_OG: Record<Locale, string> = {
  'en-US': 'en_US',
  es: 'es_ES',
};

export const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English',
  es: 'Español',
};

export const DEFAULT_NAMESPACE = 'common';
export const ROOT_NAMESPACES = ['common'] as const;
export const SEED_NAMESPACES = ['common', 'marketing'] as const;
export type SeedNamespace = (typeof SEED_NAMESPACES)[number];

export const LOCALE_HEADER = 'x-boardsesh-locale';
export const LOCALE_COOKIE = 'boardsesh-locale';
// 1 year — long enough to survive between sessions, short enough that abandoned
// devices don't carry the preference forever.
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
