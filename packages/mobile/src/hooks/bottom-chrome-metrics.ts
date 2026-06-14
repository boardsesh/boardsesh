import type { UiVariant } from '../theme/resolve-ui-variant';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  TAB_BAR_HEIGHT,
  TOOLBAR_GAP_ABOVE_TABBAR,
  TOOLBAR_RESERVE,
} from '../theme/layout';

/**
 * Inputs the React hook gathers (safe-area insets, route, queue, capability)
 * reduced to the primitives the math needs. Kept separate from
 * {@link import('./use-bottom-chrome-metrics').useBottomChromeMetrics} so the
 * arbitration is a pure, unit-tested function: it decides whether the last list
 * row, the queue-added snackbar, and the filter FAB clear the tab bar /
 * accessory — a class of bug that is invisible in code review and only shows on
 * device. (Replaces the unit-tested pure `queueSnackbarBottomOffset` that was
 * folded into the hook.)
 */
export type BottomChromeInputs = {
  /** Resolved UI variant; controls the JS toolbar shape/reserve. */
  uiVariant: UiVariant;
  /** Bottom safe-area inset. */
  insetsBottom: number;
  /** Whether the current route is inside the (tabs) group (tab bar present). */
  insideTabs: boolean;
  /** Whether a climb is currently set (drives the toolbar / accessory). */
  hasCurrentClimb: boolean;
  /** Deprecated: the rest timer now lives in the top header, so this no longer affects bottom reserves. */
  hasRepTimer: boolean;
  /** Current rendered height of the native accessory when mounted. */
  nativeAccessoryHeight: number;
  /** Whether the iOS 26 native bottom accessory is mounted (it replaces the JS toolbar). */
  nativeAccessoryMounted: boolean;
};

export type BottomChromeMetrics = {
  hasCurrentClimb: boolean;
  insideTabs: boolean;
  nativeAccessoryMounted: boolean;
  nativeAccessoryVisible: boolean;
  jsQueueToolbarVisible: boolean;
  tabBarHeight: number;
  tabBarBottom: number;
  /** Deprecated compatibility field; always zero because the timer lives in the top header. */
  repTimerReserve: number;
  jsQueueReserve: number;
  nativeAccessoryReserve: number;
  /** Bottom padding for scroll views so the last row clears the tab bar + JS-owned chrome. */
  scrollBottomPadding: number;
  /** Bottom offset for floating controls (FABs, snackbar) so they clear all chrome. */
  floatingControlBottom: number;
  /**
   * Bottom padding for fixed footers. NativeTabs overlays content, so fixed
   * footers clear the tab bar there. Material JS tabs are in flow, so fixed
   * footers clear only active queue/accessory chrome.
   */
  fixedFooterBottom: number;
};

/**
 * Pure bottom-chrome arbitration. `nativeAccessoryVisible` and
 * `jsQueueToolbarVisible` are mutually exclusive (the JS toolbar only mounts
 * when the native accessory does not). The native accessory is UIKit-owned and
 * adds its own accessory inset, so `scrollBottomPadding` reserves only for the
 * JS-owned chrome: the JS toolbar. Liquid Glass reserves the taller floating
 * island stack; Material reserves the docked active-context bar height.
 * `scrollBottomPadding` remains
 * conservative for list/scroll consumers and keeps tab-bar clearance on both
 * tab implementations; fixed footers use `fixedFooterBottom` because they need
 * the in-flow-vs-overlay tab-bar distinction. `floatingControlBottom` clears
 * the physical tab bar because those controls are absolute overlays.
 */
export function computeBottomChromeMetrics({
  uiVariant,
  insetsBottom,
  insideTabs,
  hasCurrentClimb,
  hasRepTimer,
  nativeAccessoryHeight,
  nativeAccessoryMounted,
}: BottomChromeInputs): BottomChromeMetrics {
  void hasRepTimer;
  const nativeAccessoryVisible = nativeAccessoryMounted && hasCurrentClimb;
  const jsQueueToolbarVisible = hasCurrentClimb && !nativeAccessoryMounted;
  // The Material variant renders the taller M3 JS nav bar; Liquid Glass uses the
  // native 49pt iOS tab bar. Floating overlays (FAB, snackbar) and scroll padding
  // clear this height, so it has to track the real bar per variant.
  const tabBarConstant = uiVariant === 'material' ? MATERIAL_TAB_BAR_HEIGHT : TAB_BAR_HEIGHT;
  const tabBarHeight = insideTabs ? tabBarConstant : 0;
  const tabBarOverlaysContent = insideTabs && uiVariant !== 'material';
  // The Material bar reserves its full height even though it's tucked ~2px into the
  // tab bar (MATERIAL_TABBAR_OVERLAP in persistent-queue-bar), so its visible height
  // above the tab bar is ~2px less. The resulting 2px of extra scroll padding is
  // intentional slack — imperceptible, and not worth threading the overlap through
  // this pure arbitration. Don't "fix" it by subtracting the overlap here.
  const jsQueueToolbarReserve = uiVariant === 'material' ? MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT : TOOLBAR_RESERVE;
  const repTimerReserve = 0;
  const jsQueueReserve = jsQueueToolbarVisible ? jsQueueToolbarReserve : 0;
  const nativeAccessoryReserve = nativeAccessoryVisible ? nativeAccessoryHeight + TOOLBAR_GAP_ABOVE_TABBAR : 0;
  const tabBarBottom = insetsBottom + tabBarHeight;
  const activeQueueChromeReserve = Math.max(jsQueueReserve, nativeAccessoryReserve);
  const contentInsetBottom = tabBarOverlaysContent || !insideTabs ? tabBarBottom : 0;
  const fixedFooterBottom = contentInsetBottom + activeQueueChromeReserve;

  return {
    hasCurrentClimb,
    insideTabs,
    nativeAccessoryMounted,
    nativeAccessoryVisible,
    jsQueueToolbarVisible,
    tabBarHeight,
    tabBarBottom,
    repTimerReserve,
    jsQueueReserve,
    nativeAccessoryReserve,
    scrollBottomPadding: insetsBottom + tabBarHeight + jsQueueReserve,
    floatingControlBottom: insetsBottom + tabBarHeight + Math.max(jsQueueReserve, nativeAccessoryReserve),
    fixedFooterBottom,
  };
}
