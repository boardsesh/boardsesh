import type { UiVariant } from '../theme/resolve-ui-variant';
// Import the leaf module (not the ./variants barrel): the barrel re-exports
// createVariantComponent, which pulls the provider + react-native and would break
// this module's pure, react-native-free unit test. select-by-variant is type-only.
import { selectByVariant } from '../theme/variants/select-by-variant';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  NATIVE_BOTTOM_ACCESSORY_HEIGHT,
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
 *
 * ## The geometry contract: two safe-area sampling points
 *
 * There are TWO places a bottom inset can be read, with different semantics, and
 * conflating them is what caused #3967 → #3973 → #4089 → the Start-capsule
 * regression this contract was written for:
 *
 * - **Root provider** (where `BottomChromeMetricsProvider` samples, above the
 *   navigator): the window's inset — home indicator only (34 on Face ID
 *   iPhones, 0 on home-button devices). UIKit tab-bar chrome never reaches it.
 * - **In-tab provider**: expo-router's `NativeTabsView` wraps each tab's
 *   content in its own nested `SafeAreaProvider`; inside it the bottom inset
 *   additionally folds in the UIKit tab bar, the BottomAccessory, and the live
 *   minimize state (DEVICE_VERIFIED 139 = 34 + 49 bar + 56 accessory,
 *   iPhone 17 Pro). `NativeTabContentInsetProbe` publishes this measurement as
 *   `measuredTabContentInsetBottom`.
 *
 * Provenance rule: never assume what UIKit folds into an inset. Position
 * against the inset measured at the surface you are positioning in, or consume
 * the published measurement; hardcoded reconstructions are fallbacks for the
 * pre-measurement frames only. Test constants must be labeled DEVICE_VERIFIED
 * (with device + state) or INFERRED.
 *
 * Known transient windows (self-correcting within frames, by design): the
 * accessory mounting/unmounting or a rotation briefly leaves a stale
 * measurement until the probe's effect re-fires on the next inset event.
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
  /**
   * Whether the iOS 26 native bottom accessory is actually PRESENTED — drawn, taking
   * up bar height — not merely whether its UIKit host is mounted. The two diverge on
   * pushed tab sub-routes: #5055 holds the host open there (so we never call
   * `setBottomAccessory:nil` under a live bar), but UIKit still stops drawing the
   * platter across a push. Reserve against what is on screen; feeding this the
   * host-mount gate reserves height for a platter that isn't there (#3776's dead gap).
   * It replaces the JS toolbar when true.
   */
  nativeAccessoryPresented: boolean;
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
  /**
   * Bottom inset measured INSIDE the focused native tab's content (see the
   * module docblock's sampling-point contract), published by
   * `NativeTabContentInsetProbe` via `native-tab-content-inset-store`. `null`
   * (the default) means "no measurement yet"; the native-overlay path then
   * reconstructs the chrome from the root inset + constants. Ignored entirely
   * off the native-tab-bar path — the JS bars sit outside every UIKit inset.
   */
  measuredTabContentInsetBottom?: number | null;
};

export type BottomChromeMetrics = {
  hasCurrentClimb: boolean;
  insideTabs: boolean;
  nativeAccessoryPresented: boolean;
  nativeAccessoryVisible: boolean;
  jsQueueToolbarVisible: boolean;
  /** Physical height of the rendered bottom tab bar; zero outside tabs/sidebar mode. */
  tabBarHeight: number;
  /**
   * Bottom clearance through the tab bar. NativeTabs returns the measured
   * in-tab inset (or its reconstruction while unmeasured) because UIKit folds
   * the bar + accessory into that inset; JS tabs add their in-flow height to
   * the root inset.
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
   * fixed-footer reserve; Liquid Glass anchors to the native chrome clearance
   * plus the JS queue reserve — identical arithmetic to
   * {@link inSessionListBottom}, and it must stay in lockstep with it: both
   * surfaces clear the same bottom chrome, and letting one branch drift is what
   * caused #3967.
   *
   * On the native tab bar, the clearance is the measured in-tab inset
   * (DEVICE_VERIFIED 139 with the accessory on an iPhone 17 Pro — see the
   * module docblock) or its reconstruction while unmeasured. The ROOT inset
   * alone is never enough here: it excludes the 49pt bar, and anchoring to it
   * is exactly how the Start capsule ended up underneath the tab bar.
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
  nativeAccessoryPresented,
  usesSidebar = false,
  detailPaneOwnsQueue = usesSidebar,
  measuredTabContentInsetBottom = null,
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
      nativeAccessoryPresented: false,
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
  // sidebar owns the chrome), so fold that into `effectiveNativeAccessoryPresented`.
  const effectiveNativeAccessoryPresented = usesSidebar ? false : nativeAccessoryPresented;
  const nativeAccessoryVisible = effectiveNativeAccessoryPresented && hasCurrentClimb;
  // The JS toolbar only mounts on an accessory surface (a top-level tab) when the
  // native accessory isn't owning the climb. On a pushed sub-route `onAccessorySurface`
  // is false, so no JS bar — and no `jsQueueReserve` for a bar that isn't there.
  const jsQueueToolbarVisible = onAccessorySurface && hasCurrentClimb && !effectiveNativeAccessoryPresented;
  // The native iOS tab bar is 49pt; the JS M3 `MaterialTabBar` is taller. Key this
  // on the *rendered* bar, not the variant — Liquid Glass on iOS < 26 / Android
  // falls back to the JS bar. `tabBarHeight` describes the rendered bar, while
  // `tabBarBottom` is the full clearance from the screen bottom: the opaque raw
  // inset for NativeTabs, or raw inset + JS bar height for the fallback.
  const tabBarConstant = usesNativeTabBar ? TAB_BAR_HEIGHT : MATERIAL_TAB_BAR_HEIGHT;
  const tabBarHeight = insideTabs && !usesSidebar ? tabBarConstant : 0;
  // Only the native tab bar overlays content (UIKit draws it over the scroll view);
  // the JS `MaterialTabBar` sits in flow. NativeTabs extends the IN-TAB safe-area
  // inset to include both the bar and its BottomAccessory (DEVICE_VERIFIED 139 =
  // 34 + 49 + 56 on an iPhone 17 Pro) — but that fold-in exists only inside the
  // tab's nested SafeAreaProvider, never in the root `insetsBottom` this function
  // receives. See the module docblock's sampling-point contract. The sidebar
  // shell never renders a native bottom bar (the rail replaces it), so a
  // synthetic "sidebar + native tab signal" call must not consume the in-tab
  // measurement or its reconstruction — hence the `!usesSidebar` term.
  const tabBarOverlaysContent = insideTabs && usesNativeTabBar && !usesSidebar;
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
  // Native-overlay clearance: prefer the live in-tab measurement (it tracks the
  // accessory and the minimize state); reconstruct from the root inset +
  // constants only while unmeasured. The `>= insetsBottom` guard rejects
  // physically impossible readings (an in-tab inset can never be smaller than
  // the window's own inset) — e.g. a probe publish that raced a provider
  // teardown — without imposing an assumption-based floor on valid ones.
  const nativeChromeFallback =
    insetsBottom + TAB_BAR_HEIGHT + (nativeAccessoryVisible ? NATIVE_BOTTOM_ACCESSORY_HEIGHT : 0);
  const nativeChromeBottom =
    measuredTabContentInsetBottom !== null && measuredTabContentInsetBottom >= insetsBottom
      ? measuredTabContentInsetBottom
      : nativeChromeFallback;
  const tabBarBottom = tabBarOverlaysContent ? nativeChromeBottom : insetsBottom + tabBarHeight;
  // Scroll padding is floored at the un-minimized reconstruction: the gesture
  // that minimizes the bar is the same one scrolling the list, and shrinking
  // contentContainer padding mid-scroll can clamp/jump the scroll offset near
  // the end of content. ≤49pt of extra padding while minimized is invisible
  // slack; floating controls deliberately keep tracking the live value instead
  // (a capsule following the minimizing bar is correct).
  const scrollTabBarBottom = tabBarOverlaysContent ? Math.max(tabBarBottom, nativeChromeFallback) : tabBarBottom;
  const activeQueueChromeReserve = Math.max(jsQueueReserve, nativeAccessoryReserve);
  const contentInsetBottom = tabBarOverlaysContent || !insideTabs ? tabBarBottom : 0;
  const fixedFooterBottom = contentInsetBottom + activeQueueChromeReserve;

  return {
    hasCurrentClimb,
    insideTabs,
    nativeAccessoryPresented: effectiveNativeAccessoryPresented,
    nativeAccessoryVisible,
    jsQueueToolbarVisible,
    tabBarHeight,
    tabBarBottom,
    jsQueueReserve,
    nativeAccessoryReserve,
    scrollBottomPadding: scrollTabBarBottom + jsQueueReserve,
    floatingControlBottom: tabBarBottom + Math.max(jsQueueReserve, nativeAccessoryReserve),
    fixedFooterBottom,
    // selectByVariant (vs a raw ternary) keeps these exhaustive: a new UiVariant is
    // a compile error here, since this file is outside the components/ guard scope.
    // The liquidGlass branch clears the native chrome (measured in-tab inset /
    // reconstruction) under the native bar, and the raw inset on the JS-bar
    // fallback where the bar is a JS overlay handled by `jsQueueReserve` (#3967).
    // The ROOT inset alone is never correct under the native bar — it excludes
    // the 49pt bar, which is exactly how the Start capsule sank beneath it.
    inSessionListBottom: selectByVariant(uiVariant, {
      material: fixedFooterBottom,
      liquidGlass: (tabBarOverlaysContent ? tabBarBottom : insetsBottom) + jsQueueReserve,
    }),
    // Keep this branch identical to `inSessionListBottom`: the JS queue tray is an
    // overlay outside the safe area, so the Start capsule only clears it when the
    // reserve is added explicitly (#3967).
    preSessionFooterBottom: selectByVariant(uiVariant, {
      material: fixedFooterBottom,
      liquidGlass: (tabBarOverlaysContent ? tabBarBottom : insetsBottom) + jsQueueReserve,
    }),
  };
}
