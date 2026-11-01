import type { Platform } from 'react-native';
import type { UiVariant } from '../theme/resolve-ui-variant';

/**
 * The raw signals that decide which tab chrome is on screen. Kept as plain
 * primitives (no react-native import) so the decision is a pure, unit-tested
 * function, and so a test can feed it without mocking the platform.
 */
export type TabChromeInputs = {
  /** `Platform.OS`. */
  platformOS: typeof Platform.OS;
  /** Resolved UI variant ('auto' already resolved). */
  variant: UiVariant;
  /**
   * Whether the device renders real iOS 26 Liquid Glass (`useGlassCapability`).
   * It no longer picks the tab bar, only the iOS 26 extras that ride on it.
   */
  glassCapable: boolean;
  /** Whether `NativeTabs.BottomAccessory` exists on this build and OS (`isBottomAccessoryAvailable`). */
  accessoryAvailable: boolean;
};

export type TabChrome = {
  /**
   * The native UIKit tab bar (`NativeTabs`) is on screen. True on every iPhone and
   * iPad in the Liquid Glass variant, iOS 18 included. HIG (Tab bars):
   * an iOS app uses the system tab bar, so it picks up the system's own
   * appearance, materials, Dynamic Type and accessibility on every OS version.
   */
  nativeTabBar: boolean;
  /**
   * The iOS 26 Liquid Glass version of that bar, with minimize-on-scroll, an iOS
   * 26 UIKit feature: an iOS 18 iPhone keeps the classic bar.
   */
  liquidGlassTabBar: boolean;
  /**
   * The current climb rides `NativeTabs.BottomAccessory` (iOS 26 only), on iPhone
   * and iPad alike. When false on the native bar (iOS 18), the JS
   * `PersistentQueueBar` floats above the bar instead, positioned by the
   * bottom-chrome metrics.
   */
  nativeAccessory: boolean;
};

/**
 * Pure tab-chrome arbitration. One function answers all three questions so the
 * tab layout, the bottom-chrome metrics and the toast offset can never disagree
 * about what is on screen.
 *
 * iPad uses the same navigator at every width: a sidebar in landscape, a tab bar
 * at the top in portrait. Like Apple Music, it keeps the current climb in the
 * bottom accessory under one content column (HIG Tab bars: "tab bars with an
 * attached accessory, like the MiniPlayer in Music"); tapping it opens the
 * full-screen player, as on iPhone.
 */
export function resolveTabChrome({
  platformOS,
  variant,
  glassCapable,
  accessoryAvailable,
}: TabChromeInputs): TabChrome {
  const nativeTabBar = platformOS === 'ios' && variant === 'liquidGlass';
  const liquidGlassTabBar = nativeTabBar && glassCapable;
  return {
    nativeTabBar,
    liquidGlassTabBar,
    nativeAccessory: liquidGlassTabBar && accessoryAvailable,
  };
}
