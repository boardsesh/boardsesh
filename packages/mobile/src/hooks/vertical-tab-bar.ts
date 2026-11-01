import type { Platform } from 'react-native';

/**
 * The smallest side inset read as system chrome on the side. A portrait iPhone
 * reports 0 on both sides; iPhone Duo's rail with the status bar above it
 * reports 84 on the inner display.
 */
export const VERTICAL_TAB_BAR_MIN_SIDE_INSET = 20;

/** Plain primitives, so the decision is a pure, unit-tested function. */
export type VerticalTabBarInputs = {
  /** `Platform.OS`. */
  platformOS: typeof Platform.OS;
  /** `Platform.isPad`. iPad keeps its own bar placement and behaviour. */
  isPad: boolean;
  windowWidth: number;
  windowHeight: number;
  /** The root (window) safe-area insets. The status bar moves to the side with the bars. */
  windowInsets: { left: number; right: number };
  /**
   * Whether the larger side inset measured inside the focused native tab, which
   * includes the tab bar itself (`native-tab-content-inset-store`), reached
   * `VERTICAL_TAB_BAR_MIN_SIDE_INSET`. False before the first measurement.
   */
  tabContentSideInsetReached: boolean;
};

/**
 * Whether iOS draws the tab bar as a vertical rail on the side: iPhone Duo closed,
 * and its inner display in landscape. HIG, "Designing for iPhone Duo": toolbars,
 * tab bars and the status bar "move to the side", except on the inner display in
 * portrait.
 *
 * Read from geometry rather than the device name:
 * - A side inset. A horizontal bar never adds one on a portrait-locked iPhone, while
 *   the rail and the side status bar do. Compared with a floor, not with the bottom
 *   inset: the bottom inset includes the current-climb accessory (~73pt in the
 *   closed Duo shots) and would overtake the rail's 84pt whenever a climb is on.
 * - A window wider than tall. iPhone apps are portrait-locked, so only the Duo's
 *   inner display gets here, and it puts the bars on the side in landscape. This
 *   answers before the first in-tab measurement lands.
 */
export function resolveVerticalTabBar({
  platformOS,
  isPad,
  windowWidth,
  windowHeight,
  windowInsets,
  tabContentSideInsetReached,
}: VerticalTabBarInputs): boolean {
  if (platformOS !== 'ios' || isPad) return false;
  if (windowWidth > windowHeight) return true;
  if (tabContentSideInsetReached) return true;
  return Math.max(windowInsets.left, windowInsets.right) >= VERTICAL_TAB_BAR_MIN_SIDE_INSET;
}
