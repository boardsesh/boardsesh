import type { MoreIconName } from '../../MoreForm.types';

/** A translate function; the caller binds it to the `common` namespace. */
export type SettingsTranslate = (key: string, options?: Record<string, unknown>) => string;

/** Every page the Settings root links to. */
export type SettingsRootPage =
  | 'general'
  | 'privacy'
  | 'account'
  | 'integrations'
  | 'board'
  | 'climbs'
  | 'earlyAccess'
  | 'developer';

/** Where each root row goes. Every one is a page registered in `app/settings/_layout.tsx`. */
export const SETTINGS_ROOT_ROUTES = {
  general: '/settings/general',
  privacy: '/settings/privacy',
  account: '/settings/account',
  integrations: '/settings/integrations',
  // The route keeps its old name: links to it predate the page's rename.
  board: '/settings/board-look',
  climbs: '/settings/climbs',
  earlyAccess: '/settings/early-access',
  developer: '/settings/developer',
} as const satisfies Record<SettingsRootPage, `/settings/${string}`>;

export const SETTINGS_ROOT_ICONS = {
  general: 'general',
  privacy: 'privacy',
  account: 'account',
  integrations: 'integrations',
  board: 'boardLook',
  climbs: 'climbs',
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
    case 'general':
      return t('mobile.settings.pages.general.title');
    case 'privacy':
      return t('settings:privacy.title');
    case 'account':
      return t('profile:mobile.account');
    case 'integrations':
      return t('settings:integrations.title');
    case 'board':
      return t('mobile.settings.pages.board.title');
    case 'climbs':
      return t('mobile.settings.pages.climbs.title');
    case 'earlyAccess':
      return t('mobile.settings.pages.earlyAccess.title');
    case 'developer':
      return t('mobile.settings.pages.developer.title');
  }
}
