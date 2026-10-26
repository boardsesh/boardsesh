import { SIDEBAR_WIDTH } from '../theme/layout';
import { resolveDetailPaneSurface, type WidthClass } from '../theme/size-class';

/**
 * Where the current climb shows outside the player:
 *
 * - `detailPane`: the JS tablet shell's persistent right-column pane
 *   (`IpadPlayPane`), on an Android tablet, Expo web or a Material-variant iPad
 *   whose window has room for it.
 * - `nativeAccessory`: the iOS 26 bottom accessory, on iPhone and iPad alike (the
 *   Music MiniPlayer). The iPhone Duo's phone split counts here too: its pane
 *   holds the player and the accessory runs along the bottom.
 * - `floatingBar`: the JS `PersistentQueueBar` (Android, iOS 18, the Material
 *   variant, and a tablet shell too narrow for the pane).
 */
export type CurrentClimbHome = 'detailPane' | 'nativeAccessory' | 'floatingBar';

export type CurrentClimbSurfaceInputs = {
  /** Launch-fixed tablet flag from `useDeviceLayout`. */
  isTablet: boolean;
  /** Live size class from `useDeviceLayout`. */
  widthClass: WidthClass;
  /** Window width, the budget the JS shell lays its columns out in. */
  windowWidth: number;
  /** `TabChrome.nativeTabBar`: the UIKit tab bar (and on iPad its sidebar) is up. */
  nativeTabBar: boolean;
  /** `TabChrome.nativeAccessory`: the bottom accessory mounts. */
  nativeAccessory: boolean;
  /** `usePhoneSplit()`: the iPhone Duo is open in landscape. */
  phoneSplit: boolean;
};

export type CurrentClimbSurface = {
  /**
   * The JS sidebar shell is on screen: a regular-width tablet without the native
   * tab bar, where a JS rail replaces the bottom tab bar. Never true on the native
   * iPad, whose UIKit sidebar leaves the bottom free for the accessory.
   */
  sidebarShell: boolean;
  home: CurrentClimbHome;
};

/**
 * The one answer to "who shows the current climb". The floating queue bar, the
 * bottom-chrome reserve, the rest-timer pill and the drawer host's tap routing
 * all read it, so no screen can show the climb twice (a floating bar over the
 * accessory) or reserve room for a surface that is not there. Pure, so it is
 * unit-tested without a device.
 */
export function resolveCurrentClimbSurface({
  isTablet,
  widthClass,
  windowWidth,
  nativeTabBar,
  nativeAccessory,
  phoneSplit,
}: CurrentClimbSurfaceInputs): CurrentClimbSurface {
  const sidebarShell = isTablet && !nativeTabBar && widthClass === 'regular';
  if (
    sidebarShell &&
    resolveDetailPaneSurface({ width: windowWidth, widthClass, sidebarWidth: SIDEBAR_WIDTH }) === 'pane'
  ) {
    return { sidebarShell, home: 'detailPane' };
  }
  if (nativeAccessory || phoneSplit) return { sidebarShell, home: 'nativeAccessory' };
  return { sidebarShell, home: 'floatingBar' };
}
