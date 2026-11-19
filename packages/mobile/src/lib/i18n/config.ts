// Polyfill Intl.PluralRules before i18next initialises. Hermes ships an
// incomplete Intl implementation, and when `Intl.PluralRules` is missing
// i18next's plural resolver silently falls back to a hardcoded English rule
// (`count === 1 ? 'one' : 'other'`), so locales with different plural
// categories pick the wrong suffix — French `count=0` renders `_other`
// instead of `_one`, and categories like `many` vanish. Mirrors how web
// wires the same polyfill in app/lib/i18n/{server.ts,client.tsx}.
import 'intl-pluralrules';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, DEFAULT_NAMESPACE, MOBILE_NAMESPACES, type Locale } from '@boardsesh/i18n';
import { setRelativeTimeLocale } from '@boardsesh/profile-stats';

import { resources } from './catalogs';

/**
 * Detect the best matching locale from the device settings.
 * Falls back to en-US if no supported locale matches.
 *
 * Exported so the locale-preference layer can resolve the `'system'` choice
 * to a concrete language without duplicating the matching logic.
 */
export function detectDeviceLocale(): Locale {
  const deviceLocales = getLocales();

  for (const deviceLocale of deviceLocales) {
    // zh-CN is our Simplified Chinese catalog. iOS usually reports zh-Hans-CN;
    // do not silently replace a Traditional Chinese preference with Simplified.
    if (deviceLocale.languageCode === 'zh') {
      const tag = deviceLocale.languageTag.toLowerCase();
      const traditional = deviceLocale.languageScriptCode === 'Hant' || tag.includes('-hant');
      const simplified = deviceLocale.languageScriptCode === 'Hans' || tag.includes('-hans');
      const traditionalRegion = /^zh-(tw|hk|mo)(-|$)/.test(tag);
      if (traditional || (traditionalRegion && !simplified)) continue;
      return 'zh-CN';
    }

    // Try exact match first (e.g. "en-US")
    const exactTag = deviceLocale.languageTag as Locale;
    if ((SUPPORTED_LOCALES as readonly string[]).includes(exactTag)) {
      return exactTag;
    }

    // Try language-only match (e.g. "es" from "es-MX")
    const languageCode = deviceLocale.languageCode;
    if (languageCode) {
      const languageMatch = SUPPORTED_LOCALES.find(
        (locale) => locale === languageCode || locale.startsWith(`${languageCode}-`),
      );
      if (languageMatch) {
        return languageMatch;
      }
    }
  }

  return DEFAULT_LOCALE;
}

const initialLocale = detectDeviceLocale();

// dayjs keeps its active locale module-global and defaults to English, so every
// "vor 6 Minuten" in the app rendered as "6 minutes ago" until this ran. Set it
// alongside i18n rather than inside the formatter: the formatter is called
// per-row during scrolling, and switching locale on every call is both wasteful
// and a cross-request hazard for the web surfaces that share the package.
setRelativeTimeLocale(initialLocale);
i18n.on('languageChanged', setRelativeTimeLocale);

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: DEFAULT_NAMESPACE,
  ns: [...MOBILE_NAMESPACES],
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
