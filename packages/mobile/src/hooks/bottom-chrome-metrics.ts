import type { UiVariant } from '../theme/resolve-ui-variant';
// Import the leaf module (not the ./variants barrel): the barrel re-exports
// createVariantComponent, which pulls the provider + react-native and would break
// this module's pure, react-native-free unit test. select-by-variant is type-only.
import { selectByVariant } from '../theme/variants/select-by-variant';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  TAB_BAR_HEIGHT,
  TOOLBAR_GAP_ABOVE_TABBAR,
  TOOLBAR_RESERVE,
  glassSize,
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
  /**
   * Whether the native iOS 26 tab bar (`NativeTabs`) is the one on screen, as
   * opposed to the JS `MaterialTabBar`. This is the *rendered tab bar*, which can
   * differ from `uiVariant`: Liquid Glass on iOS < 26 / Android falls back to the
   * JS bar. Drives tab-bar height + whether the bar overlays content.
   */
  usesNativeTabBar: boolean;
  /** Bottom safe-area inset. */
  insetsBottom: number;
  /** Whether the current route is inside the (tabs) group (tab bar present). */
  insideTabs: boolean;
  /** Whether a climb is currently set (drives the toolbar / accessory). */
  hasCurrentClimb: boolean;
  /** Whether the iOS 26 native bottom accessory is mounted (it replaces the JS toolbar). */
  nativeAccessoryMounted: boolean;
  /**
   * Whether the regular-width iPad shell is on screen: a left sidebar replaces
   * the bottom tab bar and the queue "now playing" lives in the sidebar footer,
   * so there is no bottom chrome to reserve for. Optional and defaults to
   * `false` — every existing (phone / compact-iPad) call site keeps its current
   * behavior unchanged. When true, every bottom offset collapses to the raw
   * safe-area inset.
   */
  usesSidebar?: boolean;
};

export type BottomChromeMetrics = {
  hasCurrentClimb: boolean;
  insideTabs: boolean;
  nativeAccessoryMounted: boolean;
  nativeAccessoryVisible: boolean;
  jsQueueToolbarVisible: boolean;
  tabBarHeight: number;
  tabBarBottom: number;
  jsQueueReserve: number;
  nativeAccessoryReserve: number;
  /** Bottom padding for scroll views so the last row clears the tab bar + JS toolbar. */
  scrollBottomPadding: number;
  /** Bottom offset for floating controls (FABs, snackbar) so they clear all chrome. */
  floatingControlBottom: number;
  /**
   * Bottom padding for fixed footers. NativeTabs overlays content, so fixed
   * footers clear the tab bar there. Material JS tabs are in flow, so fixed
   * footers clear only active queue/accessory chrome.
   */
  fixedFooterBottom: number;
  /**
   * Bottom padding for the in-session climb list. Material docks a fixed footer
   * (clears active queue/accessory chrome via `fixedFooterBottom`); Liquid Glass
   * floats, so the list clears the raw safe-area inset plus only the JS queue
   * reserve — the glass tab bar already extends the UIKit inset, so adding the
   * tab bar height again would double-count it.
   */
  inSessionListBottom: number;
  /**
   * Bottom offset for the pre-session Start capsule / footer. Material uses the
   * fixed-footer reserve; Liquid Glass anchors to the raw safe-area inset.
   *
   * Verified on-device (iPhone 17 Pro / iOS 26): with the native tab bar + climb
   * accessory present, the safe-area bottom inset is 139 = home indicator (34) +
   * tab bar (49) + accessory (56) — the glass tab bar extends the UIKit safe area.
   * `fixedFooterBottom` would add the tab bar + accessory a second time (246),
   * stranding the control ~110px up the screen — hence the raw inset on glass.
   */
  preSessionFooterBottom: number;
};

/**
 * Pure bottom-chrome arbitration. `nativeAccessoryVisible` and
 * `jsQueueToolbarVisible` are mutually exclusive (the JS toolbar only mounts
 * when the native accessory does not). The native accessory is UIKit-owned and
 * adds its own content inset, so `scrollBottomPadding` reserves only for the JS
 * toolbar. Liquid Glass reserves the taller floating island stack; Material
 * reserves the docked active-context bar height. `scrollBottomPadding` remains
 * conservative for list/scroll consumers and keeps tab-bar clearance on both
 * tab implementations; fixed footers use `fixedFooterBottom` because they need
 * the in-flow-vs-overlay tab-bar distinction. `floatingControlBottom` clears
 * the physical tab bar because those controls are absolute overlays.
 */
export function computeBottomChromeMetrics({
  uiVariant,
  usesNativeTabBar,
  insetsBottom,
  insideTabs,
  hasCurrentClimb,
  nativeAccessoryMounted,
  usesSidebar = false,
}: BottomChromeInputs): BottomChromeMetrics {
  // Regular-width iPad: the left sidebar replaces the bottom tab bar and the
  // queue "now playing" rides the sidebar footer, so nothing floats at the
  // bottom. Every offset collapses to the raw safe-area inset — there is no tab
  // bar, JS toolbar, or native accessory to clear. Short-circuit before the
  // phone arithmetic so a future tab-bar retune can't leak a reserve in here.
  if (usesSidebar) {
    return {
      hasCurrentClimb,
      insideTabs,
      nativeAccessoryMounted: false,
      nativeAccessoryVisible: false,
      jsQueueToolbarVisible: false,
      tabBarHeight: 0,
      tabBarBottom: insetsBottom,
      jsQueueReserve: 0,
      nativeAccessoryReserve: 0,
      scrollBottomPadding: insetsBottom,
      floatingControlBottom: insetsBottom,
      fixedFooterBottom: insetsBottom,
      inSessionListBottom: insetsBottom,
      preSessionFooterBottom: insetsBottom,
    };
  }

  const nativeAccessoryVisible = nativeAccessoryMounted && hasCurrentClimb;
  const jsQueueToolbarVisible = hasCurrentClimb && !nativeAccessoryMounted;
  // The native iOS tab bar is 49pt; the JS M3 `MaterialTabBar` is taller. Key this
  // on the *rendered* bar, not the variant — Liquid Glass on iOS < 26 / Android
  // falls back to the JS bar. Floating overlays (FAB, snackbar) and scroll padding
  // clear this height, so it has to track the real bar on screen.
  const tabBarConstant = usesNativeTabBar ? TAB_BAR_HEIGHT : MATERIAL_TAB_BAR_HEIGHT;
  const tabBarHeight = insideTabs ? tabBarConstant : 0;
  // Only the native tab bar overlays content (UIKit draws it over the scroll view);
  // the JS `MaterialTabBar` sits in flow.
  const tabBarOverlaysContent = insideTabs && usesNativeTabBar;
  // The Material bar reserves its full height even though it's tucked ~2px into the
  // tab bar (MATERIAL_TABBAR_OVERLAP in persistent-queue-bar), so its visible height
  // above the tab bar is ~2px less. The resulting 2px of extra scroll padding is
  // intentional slack — imperceptible, and not worth threading the overlap through
  // this pure arbitration. Don't "fix" it by subtracting the overlap here.
  const jsQueueToolbarReserve = uiVariant === 'material' ? MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT : TOOLBAR_RESERVE;
  const jsQueueReserve = jsQueueToolbarVisible ? jsQueueToolbarReserve : 0;
  const nativeAccessoryReserve = nativeAccessoryVisible ? glassSize.standard + TOOLBAR_GAP_ABOVE_TABBAR : 0;
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
    jsQueueReserve,
    nativeAccessoryReserve,
    scrollBottomPadding: insetsBottom + tabBarHeight + jsQueueReserve,
    floatingControlBottom: insetsBottom + tabBarHeight + Math.max(jsQueueReserve, nativeAccessoryReserve),
    fixedFooterBottom,
    // selectByVariant (vs a raw ternary) keeps these exhaustive: a new UiVariant is
    // a compile error here, since this file is outside the components/ guard scope.
    inSessionListBottom: selectByVariant(uiVariant, {
      material: fixedFooterBottom,
      liquidGlass: insetsBottom + jsQueueReserve,
    }),
    preSessionFooterBottom: selectByVariant(uiVariant, { material: fixedFooterBottom, liquidGlass: insetsBottom }),
  };
}
