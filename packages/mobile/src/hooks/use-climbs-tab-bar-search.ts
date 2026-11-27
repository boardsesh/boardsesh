import { Platform } from 'react-native';
import { getSetting } from '../settings';
import { useTabChrome } from './use-bottom-accessory';
import { useDeviceLayout } from './use-device-layout';

type ClimbsTabBarSearchInputs = {
  /** The iOS 26 Liquid Glass tab bar is on screen (`useTabChrome`). */
  liquidGlassTabBar: boolean;
  isPad: boolean;
  /** `Platform.Version`; iOS reports a dotted string such as "26.1". */
  osVersion: string | number;
};

/**
 * react-native-screens builds a real UISearchTab only on iOS 26.1+
 * (`RNS_UITAB_API_ENABLED`). On 26.0 a search-role tab is a legacy tab bar
 * item that leaves the field in the screen's header, so 26.0 keeps the
 * ordinary tab.
 */
export function supportsUiSearchTab(osVersion: string | number): boolean {
  const [major = 0, minor = 0] = String(osVersion)
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
  return major > 26 || (major === 26 && minor >= 1);
}

/**
 * Whether this device can make Climbs the bar's search tab at all: the iPhone's
 * Liquid Glass bar. iOS 18 and 26.0 have no UISearchTab, Material and Android
 * draw a JS bar, and on iPad the bar turns into a sidebar, which keeps an ordinary
 * Climbs row. Where this is false the setting is not offered.
 */
export function climbsTabBarSearchAvailable({
  liquidGlassTabBar,
  isPad,
  osVersion,
}: ClimbsTabBarSearchInputs): boolean {
  return liquidGlassTabBar && !isPad && supportsUiSearchTab(osVersion);
}

export function useClimbsTabBarSearchAvailable(): boolean {
  const { liquidGlassTabBar } = useTabChrome();
  const { isPad } = useDeviceLayout();
  return climbsTabBarSearchAvailable({ liquidGlassTabBar, isPad, osVersion: Platform.Version });
}

// The choice this launch runs with. See `climbsTabBarSearchLaunchChoice`.
let launchChoice: boolean | null = null;

/**
 * The stored choice, read once per launch and then held. Changing a tab's role
 * remounts the tab and resets its stack, and Settings can be open inside the
 * Climbs stack, so applying a flip at once would throw the climber out of the
 * page they flipped it on. A flip applies from the next start instead, like the
 * start-up tab (`getAppEntryTab`). Anything but a stored `false` is on.
 */
export function climbsTabBarSearchLaunchChoice(): boolean {
  launchChoice ??= getSetting('climbsTabBarSearch') !== false;
  return launchChoice;
}

export function resetClimbsTabBarSearchLaunchChoiceForTests(): void {
  launchChoice = null;
}

/**
 * Climbs is the bar's search tab (`role="search"`, a UISearchTab on iOS 26.1+):
 * set apart at the right of the bar, with a climb-name search field in the bar
 * itself, like Apple Music's Search. The tab layout reads this for the trigger's
 * role and the Climbs screen for its `headerSearchBarOptions`, so the two always
 * agree. The climber turns it off in the Climbs list's View options (Climbs ⋯ ›
 * View options › Tab bar, also Settings › Climbs & grades › Climb list), from
 * the next launch; off, the bar is the one from before #8261.
 */
export function useClimbsTabBarSearch(): boolean {
  const available = useClimbsTabBarSearchAvailable();
  return available && climbsTabBarSearchLaunchChoice();
}
