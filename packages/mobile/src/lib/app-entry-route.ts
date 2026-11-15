import { getSetting } from '../settings/hooks';
import type { StartupScreen } from '../settings/types';

/**
 * The tab an ordinary launch opens on: Climbs, reusing the saved board, unless
 * the climber chose Home in Settings › Home (#6289).
 *
 * Synchronous on purpose. `app/(tabs)/_layout.tsx` reads it at module load for
 * `initialRouteName`, and the launcher and auth redirects read it on render, so
 * an async store would open on the wrong tab first. The MMKV settings store
 * answers synchronously on native and in the browser app.
 *
 * Only ordinary entry asks. A deep link resolves to its own route, a tapped
 * notification pushes over whatever tab is showing, onboarding pushes the
 * first-board picker over it, and a post-login return href is read first.
 *
 */
export function getAppEntryTab(): StartupScreen {
  return normaliseStartupScreen(getSetting('startupScreen'));
}

/**
 * The start-up tab a stored value means. Compared, not cast: anything but
 * `home` (a third option from a newer bundle after an OTA rollback, broken
 * bytes) is Climbs, so launch and the Settings row always agree on one tab.
 */
export function normaliseStartupScreen(storedValue: unknown): StartupScreen {
  return storedValue === 'home' ? 'home' : 'climbs';
}

export function getAppEntryHref(): '/(tabs)/home' | '/(tabs)/climbs' {
  return `/(tabs)/${getAppEntryTab()}`;
}
