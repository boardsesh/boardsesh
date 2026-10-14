import type { MoreIconName } from '../../MoreForm.types';

/** A translate function; the caller binds it to the `common` namespace. */
export type SettingsTranslate = (key: string, options?: Record<string, unknown>) => string;

/** Every page the Settings root links to. */
export type SettingsRootPage =
  | 'privacy'
  | 'integrations'
  | 'account'
  | 'boardLook'
  | 'offline'
  | 'general'
  | 'climbs'
  | 'boardLighting'
  | 'earlyAccess'
  | 'developer';

/** Where each root row goes. Every one is a page registered in `app/settings/_layout.tsx`. */
export const SETTINGS_ROOT_ROUTES = {
  privacy: '/settings/privacy',
  integrations: '/settings/integrations',
  account: '/settings/account',
  boardLook: '/settings/board-look',
  offline: '/settings/offline',
  general: '/settings/general',
  climbs: '/settings/climbs',
  boardLighting: '/settings/board-lighting',
  earlyAccess: '/settings/early-access',
  developer: '/settings/developer',
} as const satisfies Record<SettingsRootPage, `/settings/${string}`>;

export const SETTINGS_ROOT_ICONS = {
  privacy: 'privacy',
  integrations: 'integrations',
  account: 'account',
  boardLook: 'boardLook',
  offline: 'offline',
  general: 'general',
  climbs: 'climbs',
  boardLighting: 'boardLighting',
  earlyAccess: 'earlyAccess',
  developer: 'developer',
} as const satisfies Record<SettingsRootPage, MoreIconName>;

/**
 * The page's name: the root row's label AND the page's header title.
 *
 * One function for both so the row a climber taps and the title they land on
 * can never drift apart. Each case is a literal key, which the i18n orphan check
 * needs to see.
 */
export function settingsPageTitle(page: SettingsRootPage, t: SettingsTranslate): string {
  switch (page) {
    case 'privacy':
      return t('settings:privacy.title');
    case 'integrations':
      return t('settings:integrations.title');
    case 'account':
      return t('profile:mobile.account');
    case 'boardLook':
      return t('mobile.settings.boardLook.title');
    case 'offline':
      return t('mobile.settings.pages.offline.title');
    case 'general':
      return t('mobile.settings.pages.general.title');
    case 'climbs':
      return t('mobile.settings.pages.climbs.title');
    case 'boardLighting':
      return t('settings:ble.lighting.title');
    case 'earlyAccess':
      return t('mobile.settings.pages.earlyAccess.title');
    case 'developer':
      return t('mobile.settings.pages.developer.title');
  }
}
