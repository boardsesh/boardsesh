// Hermes ships an incomplete Intl.PluralRules. This side-effect import installs
// a polyfill so i18next's v4 plural resolver works instead of falling back to
// v3 handling (which mis-pluralises es/fr). Must run before i18n.init below.
import 'intl-pluralrules';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, DEFAULT_NAMESPACE, MOBILE_NAMESPACES, type Locale } from '@boardsesh/i18n';

// --- Locale catalogs from @boardsesh/i18n ---
// Static imports so Metro bundles only the namespaces the mobile app uses;
// web-only namespaces (marketing, admin) are never pulled in.
import commonEn from '@boardsesh/i18n/locales/en-US/common.json';
import commonEs from '@boardsesh/i18n/locales/es/common.json';
import commonFr from '@boardsesh/i18n/locales/fr/common.json';

import authEn from '@boardsesh/i18n/locales/en-US/auth.json';
import authEs from '@boardsesh/i18n/locales/es/auth.json';
import authFr from '@boardsesh/i18n/locales/fr/auth.json';

import climbsEn from '@boardsesh/i18n/locales/en-US/climbs.json';
import climbsEs from '@boardsesh/i18n/locales/es/climbs.json';
import climbsFr from '@boardsesh/i18n/locales/fr/climbs.json';

import sessionEn from '@boardsesh/i18n/locales/en-US/session.json';
import sessionEs from '@boardsesh/i18n/locales/es/session.json';
import sessionFr from '@boardsesh/i18n/locales/fr/session.json';

import profileEn from '@boardsesh/i18n/locales/en-US/profile.json';
import profileEs from '@boardsesh/i18n/locales/es/profile.json';
import profileFr from '@boardsesh/i18n/locales/fr/profile.json';

import settingsEn from '@boardsesh/i18n/locales/en-US/settings.json';
import settingsEs from '@boardsesh/i18n/locales/es/settings.json';
import settingsFr from '@boardsesh/i18n/locales/fr/settings.json';

import playlistsEn from '@boardsesh/i18n/locales/en-US/playlists.json';
import playlistsEs from '@boardsesh/i18n/locales/es/playlists.json';
import playlistsFr from '@boardsesh/i18n/locales/fr/playlists.json';

import notificationsEn from '@boardsesh/i18n/locales/en-US/notifications.json';
import notificationsEs from '@boardsesh/i18n/locales/es/notifications.json';
import notificationsFr from '@boardsesh/i18n/locales/fr/notifications.json';

import feedEn from '@boardsesh/i18n/locales/en-US/feed.json';
import feedEs from '@boardsesh/i18n/locales/es/feed.json';
import feedFr from '@boardsesh/i18n/locales/fr/feed.json';

import youEn from '@boardsesh/i18n/locales/en-US/you.json';
import youEs from '@boardsesh/i18n/locales/es/you.json';
import youFr from '@boardsesh/i18n/locales/fr/you.json';

import boardsEn from '@boardsesh/i18n/locales/en-US/boards.json';
import boardsEs from '@boardsesh/i18n/locales/es/boards.json';
import boardsFr from '@boardsesh/i18n/locales/fr/boards.json';

import auroraEn from '@boardsesh/i18n/locales/en-US/aurora.json';
import auroraEs from '@boardsesh/i18n/locales/es/aurora.json';
import auroraFr from '@boardsesh/i18n/locales/fr/aurora.json';

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
} as const;

/**
 * Detect the best matching locale from the device settings.
 * Falls back to en-US if no supported locale matches.
 */
function detectDeviceLocale(): Locale {
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

i18n.use(initReactI18next).init({
  compatibilityJSON: 'v4',
  resources,
  lng: detectDeviceLocale(),
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: DEFAULT_NAMESPACE,
  ns: [...MOBILE_NAMESPACES],
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
