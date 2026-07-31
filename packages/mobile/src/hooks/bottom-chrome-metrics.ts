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
  /** Whether the current route is inside the (tabs) group (tab bar present, incl. sub-routes). */
  insideTabs: boolean;
  /**
   * Whether the current route is a surface where the climb accessory/toolbar shows —
   * a top-level tab page (or occluded under the player). Pushed sub-routes are inside
   * the tabs (tab bar present) but NOT accessory surfaces, so the bar is hidden there.
   */
  onAccessorySurface: boolean;
  /** Whether a climb is currently set (drives the toolbar / accessory). */
  hasCurrentClimb: boolean;
  /** Whether the iOS 26 native bottom accessory is mounted (it replaces the JS toolbar). */
  nativeAccessoryMounted: boolean;
  /**
   * Whether the regular-width iPad shell is on screen: a left sidebar replaces
   * the bottom tab bar. Optional and defaults to `false` — every existing
   * (phone / compact-iPad) call site keeps its current behavior unchanged.
   */
  usesSidebar?: boolean;
  /**
   * Whether the selected-climb detail pane is mounted and owns the queue toolbar.
   * Defaults to `usesSidebar` for backward-compatible pure calls: full iPad
   * pane mode has no bottom chrome, but narrow regular iPad windows still need
   * the JS queue toolbar because the pane is suppressed there.
   */
  detailPaneOwnsQueue?: boolean;
};

export type BottomChromeMetrics = {
  hasCurrentClimb: boolean;
  insideTabs: boolean;
  nativeAccessoryMounted: boolean;
  nativeAccessoryVisible: boolean;
  jsQueueToolbarVisible: boolean;
  /** Physical height of the rendered bottom tab bar; zero outside tabs/sidebar mode. */
  tabBarHeight: number;
  /**
   * Bottom clearance through the tab bar. NativeTabs returns the raw UIKit inset
   * because it already contains native chrome; JS tabs add their in-flow height.
   */
  tabBarBottom: number;
  jsQueueReserve: number;
  /**
   * Accessory clearance not already present in the safe-area inset. This is zero
   * on the real NativeTabs path because UIKit owns and insets BottomAccessory.
   */
  nativeAccessoryReserve: number;
  /** Bottom padding for scroll views so the last row clears the tab bar + JS toolbar. */
  scrollBottomPadding: number;
  /** Bottom offset for floating controls (FABs, snackbar) so they clear all chrome. */
  floatingControlBottom: number;
  /**
   * Bottom padding for fixed footers. NativeTabs overlays content, so fixed
   * footers use the raw UIKit inset that already clears native chrome. Material
   * JS tabs are in flow, so fixed footers clear only active queue chrome.
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
   * fixed-footer reserve; Liquid Glass anchors to the raw safe-area inset plus
   * the JS queue reserve — identical arithmetic to {@link inSessionListBottom},
   * and it must stay in lockstep with it: both surfaces clear the same bottom
   * chrome, and letting one branch drift is what caused #3967.
   *
   * Verified on-device (iPhone 17 Pro / iOS 26): with the native tab bar + climb
   * accessory present, the safe-area bottom inset is 139 = home indicator (34) +
   * tab bar (49) + accessory (56) — the glass tab bar extends the UIKit safe area.
   * Every native-tab metric starts at that raw inset, rather than adding either
   * piece of UIKit-owned chrome again; only separately rendered JS queue chrome
   * may add a reserve. That evidence covers the *native tab bar* path with the
   * accessory, where `jsQueueReserve` is 0, so this stays exactly 139.
   *
   * On the JS-tab-bar fallback (iOS < 26, non-glass-capable iPhones, iPad in a
   * narrow split, Android forced to Liquid Glass) the floating
   * `PersistentQueueBar` is a JS overlay that does NOT extend the UIKit safe
   * area, so nothing reserves for it implicitly — the raw inset alone dropped
   * the Start capsule under the tray's log-ascent tick (#3967). Hence the
   * explicit `+ jsQueueReserve`.
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
  onAccessorySurface,
  hasCurrentClimb,
  nativeAccessoryMounted,
  usesSidebar = false,
  detailPaneOwnsQueue = usesSidebar,
}: BottomChromeInputs): BottomChromeMetrics {
  // Regular-width iPad with the detail pane mounted: the left sidebar replaces
  // the bottom tab bar and the selected-climb pane replaces the floating queue
  // toolbar, so nothing floats at the bottom. Every offset collapses to the raw
  // safe-area inset. Narrow regular iPad windows still pass `usesSidebar=true`,
  // but `detailPaneOwnsQueue=false`, so they skip this branch and keep the JS
  // queue toolbar while still removing the bottom tab bar height below.
  if (usesSidebar && detailPaneOwnsQueue) {
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

  // On the regular-width sidebar shell the native accessory never mounts (the
  // sidebar owns the chrome), so fold that into `effectiveNativeAccessoryMounted`.
  const effectiveNativeAccessoryMounted = usesSidebar ? false : nativeAccessoryMounted;
  const nativeAccessoryVisible = effectiveNativeAccessoryMounted && hasCurrentClimb;
  // The JS toolbar only mounts on an accessory surface (a top-level tab) when the
  // native accessory isn't owning the climb. On a pushed sub-route `onAccessorySurface`
  // is false, so no JS bar — and no `jsQueueReserve` for a bar that isn't there.
  const jsQueueToolbarVisible = onAccessorySurface && hasCurrentClimb && !effectiveNativeAccessoryMounted;
  // The native iOS tab bar is 49pt; the JS M3 `MaterialTabBar` is taller. Key this
  // on the *rendered* bar, not the variant — Liquid Glass on iOS < 26 / Android
  // falls back to the JS bar. `tabBarHeight` describes the rendered bar, while
  // `tabBarBottom` is the full clearance from the screen bottom: the opaque raw
  // inset for NativeTabs, or raw inset + JS bar height for the fallback.
  const tabBarConstant = usesNativeTabBar ? TAB_BAR_HEIGHT : MATERIAL_TAB_BAR_HEIGHT;
  const tabBarHeight = insideTabs && !usesSidebar ? tabBarConstant : 0;
  // Only the native tab bar overlays content (UIKit draws it over the scroll view);
  // the JS `MaterialTabBar` sits in flow. NativeTabs extends UIKit's safe-area
  // inset to include both the bar and its BottomAccessory, so neither is an
  // additional bottom offset. On-device, that inset is 139pt with an accessory on
  // an iPhone 17 Pro (34 home indicator + 49 tab bar + 56 accessory).
  const tabBarOverlaysContent = insideTabs && usesNativeTabBar;
  // The Material bar reserves its full height even though it's tucked ~2px into the
  // tab bar (MATERIAL_TABBAR_OVERLAP in persistent-queue-bar), so its visible height
  // above the tab bar is ~2px less. The resulting 2px of extra scroll padding is
  // intentional slack — imperceptible, and not worth threading the overlap through
  // this pure arbitration. Don't "fix" it by subtracting the overlap here.
  const jsQueueToolbarReserve = uiVariant === 'material' ? MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT : TOOLBAR_RESERVE;
  const jsQueueReserve = jsQueueToolbarVisible ? jsQueueToolbarReserve : 0;
  // A native accessory is UIKit-owned and already folded into `insetsBottom` on
  // the real NativeTabs path. Keep this field as an *additional* reserve so every
  // offset below can use one shared formula without double-counting it. The
  // non-overlay branch only keeps this pure total function conservative if a
  // future or synthetic caller supplies the otherwise-inconsistent combination
  // "native accessory visible without NativeTabs".
  const nativeAccessoryReserve =
    nativeAccessoryVisible && !tabBarOverlaysContent ? glassSize.standard + TOOLBAR_GAP_ABOVE_TABBAR : 0;
  const tabBarBottom = insetsBottom + (tabBarOverlaysContent ? 0 : tabBarHeight);
  const activeQueueChromeReserve = Math.max(jsQueueReserve, nativeAccessoryReserve);
  const contentInsetBottom = tabBarOverlaysContent || !insideTabs ? tabBarBottom : 0;
  const fixedFooterBottom = contentInsetBottom + activeQueueChromeReserve;

  return {
    hasCurrentClimb,
    insideTabs,
    nativeAccessoryMounted: effectiveNativeAccessoryMounted,
    nativeAccessoryVisible,
    jsQueueToolbarVisible,
    tabBarHeight,
    tabBarBottom,
    jsQueueReserve,
    nativeAccessoryReserve,
    scrollBottomPadding: tabBarBottom + jsQueueReserve,
    floatingControlBottom: tabBarBottom + Math.max(jsQueueReserve, nativeAccessoryReserve),
    fixedFooterBottom,
    // selectByVariant (vs a raw ternary) keeps these exhaustive: a new UiVariant is
    // a compile error here, since this file is outside the components/ guard scope.
    inSessionListBottom: selectByVariant(uiVariant, {
      material: fixedFooterBottom,
      liquidGlass: insetsBottom + jsQueueReserve,
    }),
    // Keep this branch identical to `inSessionListBottom`: the JS queue tray is an
    // overlay outside the safe area, so the Start capsule only clears it when the
    // reserve is added explicitly (#3967).
    preSessionFooterBottom: selectByVariant(uiVariant, {
      material: fixedFooterBottom,
      liquidGlass: insetsBottom + jsQueueReserve,
    }),
  };
}
