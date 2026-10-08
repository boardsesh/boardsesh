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
  /** Launch-fixed tablet flag from `useDeviceLayout`. */
  isTablet: boolean;
  /** Whether `NativeTabs.BottomAccessory` exists on this build and OS (`isBottomAccessoryAvailable`). */
  accessoryAvailable: boolean;
};

export type TabChrome = {
  /**
   * The native UIKit tab bar (`NativeTabs`) is the bottom bar on screen. True on
   * every iPhone in the Liquid Glass variant, iOS 18 included. HIG (Tab bars):
   * an iOS app uses the system tab bar, so it picks up the system's own
   * appearance, materials, Dynamic Type and accessibility on every OS version.
   */
  nativeTabBar: boolean;
  /**
   * The iOS 26 Liquid Glass version of that bar: the separated search tab and
   * minimize-on-scroll. Both are iOS 26 UIKit features, so an iOS 18 iPhone
   * keeps the classic bar with Climbs as an ordinary labelled tab.
   */
  liquidGlassTabBar: boolean;
  /**
   * The current climb rides `NativeTabs.BottomAccessory` (iOS 26 only). When
   * false on the native bar (iOS 18), the JS `PersistentQueueBar` floats above
   * the bar instead, positioned by the bottom-chrome metrics.
   */
  nativeAccessory: boolean;
};

/**
 * Pure tab-chrome arbitration. One function answers all three questions so the
 * tab layout, the bottom-chrome metrics, the toast offset and the climbs search
 * mode can never disagree about what is on screen.
 *
 * iPad uses the same navigator at every width. Its permanent Wall destination
 * remains registered when UIKit adapts the sidebar to a tab bar, so resizing
 * never changes trigger visibility or resets tab history. The bottom accessory
 * remains an iPhone surface; iPad's selected climb lives in the detail pane.
 */
export function resolveTabChrome({
  platformOS,
  variant,
  glassCapable,
  isTablet,
  accessoryAvailable,
}: TabChromeInputs): TabChrome {
  const nativeTabBar = platformOS === 'ios' && variant === 'liquidGlass';
  const liquidGlassTabBar = nativeTabBar && glassCapable;
  return {
    nativeTabBar,
    liquidGlassTabBar,
    nativeAccessory: liquidGlassTabBar && accessoryAvailable && !isTablet,
  };
}
