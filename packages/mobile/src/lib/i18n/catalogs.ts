// --- Locale catalogs from @boardsesh/i18n ---
// Static imports so Metro bundles only the namespaces the mobile app uses;
// web-only namespaces (marketing, admin) are never pulled in.
import consentEn from '@boardsesh/i18n/locales/en-US/consent.json';
import commonEn from '@boardsesh/i18n/locales/en-US/common.json';
import consentEs from '@boardsesh/i18n/locales/es/consent.json';
import commonEs from '@boardsesh/i18n/locales/es/common.json';
import consentFr from '@boardsesh/i18n/locales/fr/consent.json';
import commonFr from '@boardsesh/i18n/locales/fr/common.json';
import consentDe from '@boardsesh/i18n/locales/de/consent.json';
import consentIt from '@boardsesh/i18n/locales/it/consent.json';
import commonDe from '@boardsesh/i18n/locales/de/common.json';
import commonIt from '@boardsesh/i18n/locales/it/common.json';

import authEn from '@boardsesh/i18n/locales/en-US/auth.json';
import authEs from '@boardsesh/i18n/locales/es/auth.json';
import authFr from '@boardsesh/i18n/locales/fr/auth.json';
import authDe from '@boardsesh/i18n/locales/de/auth.json';
import authIt from '@boardsesh/i18n/locales/it/auth.json';

import climbsEn from '@boardsesh/i18n/locales/en-US/climbs.json';
import climbsEs from '@boardsesh/i18n/locales/es/climbs.json';
import climbsFr from '@boardsesh/i18n/locales/fr/climbs.json';
import climbsDe from '@boardsesh/i18n/locales/de/climbs.json';
import climbsIt from '@boardsesh/i18n/locales/it/climbs.json';

import sessionEn from '@boardsesh/i18n/locales/en-US/session.json';
import sessionEs from '@boardsesh/i18n/locales/es/session.json';
import sessionFr from '@boardsesh/i18n/locales/fr/session.json';
import sessionDe from '@boardsesh/i18n/locales/de/session.json';
import sessionIt from '@boardsesh/i18n/locales/it/session.json';

import profileEn from '@boardsesh/i18n/locales/en-US/profile.json';
import profileEs from '@boardsesh/i18n/locales/es/profile.json';
import profileFr from '@boardsesh/i18n/locales/fr/profile.json';
import profileDe from '@boardsesh/i18n/locales/de/profile.json';
import profileIt from '@boardsesh/i18n/locales/it/profile.json';

import settingsEn from '@boardsesh/i18n/locales/en-US/settings.json';
import settingsEs from '@boardsesh/i18n/locales/es/settings.json';
import settingsFr from '@boardsesh/i18n/locales/fr/settings.json';
import settingsDe from '@boardsesh/i18n/locales/de/settings.json';
import settingsIt from '@boardsesh/i18n/locales/it/settings.json';

import playlistsEn from '@boardsesh/i18n/locales/en-US/playlists.json';
import playlistsEs from '@boardsesh/i18n/locales/es/playlists.json';
import playlistsFr from '@boardsesh/i18n/locales/fr/playlists.json';
import playlistsDe from '@boardsesh/i18n/locales/de/playlists.json';
import playlistsIt from '@boardsesh/i18n/locales/it/playlists.json';

import notificationsEn from '@boardsesh/i18n/locales/en-US/notifications.json';
import notificationsEs from '@boardsesh/i18n/locales/es/notifications.json';
import notificationsFr from '@boardsesh/i18n/locales/fr/notifications.json';
import notificationsDe from '@boardsesh/i18n/locales/de/notifications.json';
import notificationsIt from '@boardsesh/i18n/locales/it/notifications.json';

import feedEn from '@boardsesh/i18n/locales/en-US/feed.json';
import feedEs from '@boardsesh/i18n/locales/es/feed.json';
import feedFr from '@boardsesh/i18n/locales/fr/feed.json';
import feedDe from '@boardsesh/i18n/locales/de/feed.json';
import feedIt from '@boardsesh/i18n/locales/it/feed.json';

import youEn from '@boardsesh/i18n/locales/en-US/you.json';
import youEs from '@boardsesh/i18n/locales/es/you.json';
import youFr from '@boardsesh/i18n/locales/fr/you.json';
import youDe from '@boardsesh/i18n/locales/de/you.json';
import youIt from '@boardsesh/i18n/locales/it/you.json';

import boardsEn from '@boardsesh/i18n/locales/en-US/boards.json';
import boardsEs from '@boardsesh/i18n/locales/es/boards.json';
import boardsFr from '@boardsesh/i18n/locales/fr/boards.json';
import boardsDe from '@boardsesh/i18n/locales/de/boards.json';
import boardsIt from '@boardsesh/i18n/locales/it/boards.json';

import auroraEn from '@boardsesh/i18n/locales/en-US/aurora.json';
import auroraEs from '@boardsesh/i18n/locales/es/aurora.json';
import auroraFr from '@boardsesh/i18n/locales/fr/aurora.json';
import auroraDe from '@boardsesh/i18n/locales/de/aurora.json';
import auroraIt from '@boardsesh/i18n/locales/it/aurora.json';

import commonZh from '@boardsesh/i18n/locales/zh-CN/common.json';
import consentZh from '@boardsesh/i18n/locales/zh-CN/consent.json';
import authZh from '@boardsesh/i18n/locales/zh-CN/auth.json';
import climbsZh from '@boardsesh/i18n/locales/zh-CN/climbs.json';
import sessionZh from '@boardsesh/i18n/locales/zh-CN/session.json';
import profileZh from '@boardsesh/i18n/locales/zh-CN/profile.json';
import settingsZh from '@boardsesh/i18n/locales/zh-CN/settings.json';
import playlistsZh from '@boardsesh/i18n/locales/zh-CN/playlists.json';
import notificationsZh from '@boardsesh/i18n/locales/zh-CN/notifications.json';
import feedZh from '@boardsesh/i18n/locales/zh-CN/feed.json';
import youZh from '@boardsesh/i18n/locales/zh-CN/you.json';
import boardsZh from '@boardsesh/i18n/locales/zh-CN/boards.json';
import auroraZh from '@boardsesh/i18n/locales/zh-CN/aurora.json';

export const resources = {
  'zh-CN': {
    common: commonZh,
    consent: consentZh,
    auth: authZh,
    climbs: climbsZh,
    session: sessionZh,
    profile: profileZh,
    settings: settingsZh,
    playlists: playlistsZh,
    notifications: notificationsZh,
    feed: feedZh,
    you: youZh,
    boards: boardsZh,
    aurora: auroraZh,
  },
  'en-US': {
    common: commonEn,
    consent: consentEn,
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
    consent: consentEs,
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
    consent: consentFr,
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
    consent: consentDe,
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
  it: {
    common: commonIt,
    consent: consentIt,
    auth: authIt,
    climbs: climbsIt,
    session: sessionIt,
    profile: profileIt,
    settings: settingsIt,
    playlists: playlistsIt,
    notifications: notificationsIt,
    feed: feedIt,
    you: youIt,
    boards: boardsIt,
    aurora: auroraIt,
  },
} as const;
