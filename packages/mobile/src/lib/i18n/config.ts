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
import { SCREENSHOT_LOCALE_OVERRIDE } from '../screenshot-mode';

// --- Locale catalogs from @boardsesh/i18n ---
// Static imports so Metro bundles only the namespaces the mobile app uses;
// web-only namespaces (marketing, admin) are never pulled in.
import commonEn from '@boardsesh/i18n/locales/en-US/common.json';
import commonEs from '@boardsesh/i18n/locales/es/common.json';
import commonFr from '@boardsesh/i18n/locales/fr/common.json';
import commonDe from '@boardsesh/i18n/locales/de/common.json';

import authEn from '@boardsesh/i18n/locales/en-US/auth.json';
import authEs from '@boardsesh/i18n/locales/es/auth.json';
import authFr from '@boardsesh/i18n/locales/fr/auth.json';
import authDe from '@boardsesh/i18n/locales/de/auth.json';

import climbsEn from '@boardsesh/i18n/locales/en-US/climbs.json';
import climbsEs from '@boardsesh/i18n/locales/es/climbs.json';
import climbsFr from '@boardsesh/i18n/locales/fr/climbs.json';
import climbsDe from '@boardsesh/i18n/locales/de/climbs.json';

import sessionEn from '@boardsesh/i18n/locales/en-US/session.json';
import sessionEs from '@boardsesh/i18n/locales/es/session.json';
import sessionFr from '@boardsesh/i18n/locales/fr/session.json';
import sessionDe from '@boardsesh/i18n/locales/de/session.json';

import profileEn from '@boardsesh/i18n/locales/en-US/profile.json';
import profileEs from '@boardsesh/i18n/locales/es/profile.json';
import profileFr from '@boardsesh/i18n/locales/fr/profile.json';
import profileDe from '@boardsesh/i18n/locales/de/profile.json';

import settingsEn from '@boardsesh/i18n/locales/en-US/settings.json';
import settingsEs from '@boardsesh/i18n/locales/es/settings.json';
import settingsFr from '@boardsesh/i18n/locales/fr/settings.json';
import settingsDe from '@boardsesh/i18n/locales/de/settings.json';

import playlistsEn from '@boardsesh/i18n/locales/en-US/playlists.json';
import playlistsEs from '@boardsesh/i18n/locales/es/playlists.json';
import playlistsFr from '@boardsesh/i18n/locales/fr/playlists.json';
import playlistsDe from '@boardsesh/i18n/locales/de/playlists.json';

import notificationsEn from '@boardsesh/i18n/locales/en-US/notifications.json';
import notificationsEs from '@boardsesh/i18n/locales/es/notifications.json';
import notificationsFr from '@boardsesh/i18n/locales/fr/notifications.json';
import notificationsDe from '@boardsesh/i18n/locales/de/notifications.json';

import feedEn from '@boardsesh/i18n/locales/en-US/feed.json';
import feedEs from '@boardsesh/i18n/locales/es/feed.json';
import feedFr from '@boardsesh/i18n/locales/fr/feed.json';
import feedDe from '@boardsesh/i18n/locales/de/feed.json';

import youEn from '@boardsesh/i18n/locales/en-US/you.json';
import youEs from '@boardsesh/i18n/locales/es/you.json';
import youFr from '@boardsesh/i18n/locales/fr/you.json';
import youDe from '@boardsesh/i18n/locales/de/you.json';

import boardsEn from '@boardsesh/i18n/locales/en-US/boards.json';
import boardsEs from '@boardsesh/i18n/locales/es/boards.json';
import boardsFr from '@boardsesh/i18n/locales/fr/boards.json';
import boardsDe from '@boardsesh/i18n/locales/de/boards.json';

import auroraEn from '@boardsesh/i18n/locales/en-US/aurora.json';
import auroraEs from '@boardsesh/i18n/locales/es/aurora.json';
import auroraFr from '@boardsesh/i18n/locales/fr/aurora.json';
import auroraDe from '@boardsesh/i18n/locales/de/aurora.json';

const resources = {
  'en-US': {
    common: commonEn,
    auth: authEn,
    climbs: climbsEn,
    session: sessionEn,
    profile: profileEn,
    settings: settingsEn,
    playlists: playlistsEn,
    notifications: notificationsEn,
    feed: feedEn,
    you: youEn,
    boards: boardsEn,
    aurora: auroraEn,
  },
  es: {
    common: commonEs,
    auth: authEs,
    climbs: climbsEs,
    session: sessionEs,
    profile: profileEs,
    settings: settingsEs,
    playlists: playlistsEs,
    notifications: notificationsEs,
    feed: feedEs,
    you: youEs,
    boards: boardsEs,
    aurora: auroraEs,
  },
  fr: {
    common: commonFr,
    auth: authFr,
    climbs: climbsFr,
    session: sessionFr,
    profile: profileFr,
    settings: settingsFr,
    playlists: playlistsFr,
    notifications: notificationsFr,
    feed: feedFr,
    you: youFr,
    boards: boardsFr,
    aurora: auroraFr,
  },
  de: {
    common: commonDe,
    auth: authDe,
    climbs: climbsDe,
    session: sessionDe,
    profile: profileDe,
    settings: settingsDe,
    playlists: playlistsDe,
    notifications: notificationsDe,
    feed: feedDe,
    you: youDe,
    boards: boardsDe,
    aurora: auroraDe,
  },
} as const;

/**
 * Detect the best matching locale from the device settings.
 * Falls back to en-US if no supported locale matches.
 *
 * Exported so the locale-preference layer can resolve the `'system'` choice
 * to a concrete language without duplicating the matching logic.
 */
export function detectDeviceLocale(): Locale {
  if (SCREENSHOT_LOCALE_OVERRIDE) {
    return SCREENSHOT_LOCALE_OVERRIDE;
  }

  const deviceLocales = getLocales();

  for (const deviceLocale of deviceLocales) {
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
