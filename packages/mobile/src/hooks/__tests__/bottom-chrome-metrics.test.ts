import { describe, it, expect } from 'vitest';
import { computeBottomChromeMetrics } from '../bottom-chrome-metrics';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  NATIVE_BOTTOM_ACCESSORY_HEIGHT,
  TAB_BAR_HEIGHT,
  TOOLBAR_RESERVE,
  floatingContextBarBottom,
  glassSize,
} from '../../theme/layout';

// ── Inset fixtures. The provenance labels are load-bearing (see the
// sampling-point contract in bottom-chrome-metrics.ts): DEVICE_VERIFIED values
// may pin product contracts; INFERRED values must be upgraded via on-device QA
// before they are treated as UIKit ground truth.
//
// What the ROOT provider (the window) reports on a Face ID iPhone: the home
// indicator alone. UIKit tab-bar chrome never reaches the root inset — that is
// what `insetsBottom` means for every native-tab case below.
const ROOT_WINDOW_INSET = 34;
// DEVICE_VERIFIED (iPhone 17 Pro, iOS 26, top-level tab, accessory visible):
// the IN-TAB inset — 34 home indicator + 49 tab bar + 56 accessory — measured
// inside the tab's nested SafeAreaProvider. An in-tab measurement, NOT a root
// inset: the pre-#4089 suite fed this value as `insetsBottom`, which is exactly
// the sampling-point conflation `measuredTabContentInsetBottom` now models
// explicitly.
const IN_TAB_MEASURED_ACCESSORY_INSET = 139;
// INFERRED (34 + 49): the in-tab inset with the bar but no accessory. Not yet
// measured on hardware — upgrade this comment with device-QA numbers.
const IN_TAB_INFERRED_BAR_INSET = ROOT_WINDOW_INSET + TAB_BAR_HEIGHT;
// An intentionally non-device root inset for total-function tests where the
// specific geometry is irrelevant.
const SYNTHETIC_ROOT_INSET = 100;

describe('computeBottomChromeMetrics', () => {
  it('reserves nothing extra outside the tabs group', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: false,
      insetsBottom: 34,
      insideTabs: false,
      onAccessorySurface: false,
      hasCurrentClimb: false,
      nativeAccessoryPresented: false,
    });
    expect(metrics.tabBarHeight).toBe(0);
    expect(metrics.tabBarBottom).toBe(34);
    expect(metrics.scrollBottomPadding).toBe(34);
    expect(metrics.floatingControlBottom).toBe(34);
    expect(metrics.fixedFooterBottom).toBe(34);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.nativeAccessoryVisible).toBe(false);
  });

  it('reserves the JS toolbar when a climb is set and the native accessory is unavailable', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
      measuredTabContentInsetBottom: IN_TAB_INFERRED_BAR_INSET,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
    expect(metrics.scrollBottomPadding).toBe(IN_TAB_INFERRED_BAR_INSET + TOOLBAR_RESERVE);
    expect(metrics.floatingControlBottom).toBe(IN_TAB_INFERRED_BAR_INSET + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(IN_TAB_INFERRED_BAR_INSET + TOOLBAR_RESERVE);
  });

  it('clears the JS Material tab bar for Liquid Glass on a non-capable device', () => {
    // Older iPhone / Android on Liquid Glass: the variant is liquidGlass (floating
    // island queue chrome → TOOLBAR_RESERVE) but the rendered bar is the 80dp JS
    // MaterialTabBar, which sits in flow rather than overlaying content.
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: false,
      insetsBottom: 0,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
    expect(metrics.tabBarHeight).toBe(MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(MATERIAL_TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.floatingControlBottom).toBe(MATERIAL_TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    // JS bar is in flow, so a fixed footer clears only the queue chrome, not the bar.
    expect(metrics.fixedFooterBottom).toBe(TOOLBAR_RESERVE);
  });

  it('reserves the docked Material bar when the JS toolbar is visible', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      usesNativeTabBar: false,
      insetsBottom: 0,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    // Material clears its taller M3 nav bar (80) — not the iOS 49.
    expect(metrics.scrollBottomPadding).toBe(MATERIAL_TAB_BAR_HEIGHT + MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    expect(metrics.floatingControlBottom).toBe(MATERIAL_TAB_BAR_HEIGHT + MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    expect(metrics.fixedFooterBottom).toBe(MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
  });

  it('anchors every native-tab offset to the measured in-tab inset, including the 139pt accessory anchor (#3973)', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      // The root window inset — the value the root-mounted provider actually
      // samples. The 139pt accessory anchor arrives as the in-tab measurement.
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryPresented: true,
      measuredTabContentInsetBottom: IN_TAB_MEASURED_ACCESSORY_INSET,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.tabBarHeight).toBe(TAB_BAR_HEIGHT);
    expect(metrics.tabBarBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
    expect(metrics.nativeAccessoryReserve).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
    expect(metrics.floatingControlBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
    expect(metrics.fixedFooterBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
    expect(metrics.preSessionFooterBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
  });

  it('hides the bar but keeps tab-bar clearance on a pushed sub-route (Material)', () => {
    // A tab sub-route (session detail, filters): still inside the tabs (tab bar
    // present) but NOT an accessory surface, so no JS toolbar and no toolbar reserve —
    // only the tab bar is cleared.
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      usesNativeTabBar: false,
      insetsBottom: 24,
      insideTabs: true,
      onAccessorySurface: false,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.tabBarHeight).toBe(MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(24 + MATERIAL_TAB_BAR_HEIGHT);
  });

  it('hides both bars on a pushed sub-route when no native accessory is mounted', () => {
    // The no-accessory fallback (iOS < 26, or the accessory path otherwise inactive):
    // nothing shows, and the tab bar still overlays content underneath (the probe stays
    // mounted on pushed sub-routes, so the measurement keeps tracking the bar there).
    // On iOS 26 the host DOES stay mounted here — see the #5055 case below.
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: false,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
      measuredTabContentInsetBottom: IN_TAB_INFERRED_BAR_INSET,
    });
    expect(metrics.nativeAccessoryVisible).toBe(false);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.tabBarHeight).toBe(TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(IN_TAB_INFERRED_BAR_INSET);
    // The session-detail fixed footer (the #3973 surface) clears the same bar.
    expect(metrics.fixedFooterBottom).toBe(IN_TAB_INFERRED_BAR_INSET);
  });

  it('reserves no accessory height on a pushed sub-route, even though the host stays mounted (#5055)', () => {
    // #5055 keeps the UIKit host mounted across a push so we never call
    // setBottomAccessory:nil under a live tab bar. UIKit still stops PRESENTING the
    // platter there, so the reserve must not grow: `nativeAccessoryPresented` is fed from
    // the presentation gate, not the host gate. Keying it on the host gate put accessory
    // height into nativeChromeFallback, which Math.max()'s past the measured inset and
    // leaves dead space under the last row (#3776).
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: false,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
      measuredTabContentInsetBottom: IN_TAB_INFERRED_BAR_INSET,
    });
    expect(metrics.nativeAccessoryVisible).toBe(false);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    // The bar alone — no accessory height folded in.
    expect(metrics.scrollBottomPadding).toBe(IN_TAB_INFERRED_BAR_INSET);
    expect(metrics.fixedFooterBottom).toBe(IN_TAB_INFERRED_BAR_INSET);
  });

  it('reserves no queue chrome for fixed footers outside the tabs group', () => {
    // The climb bar only shows on top-level tab pages now, so a root-level surface
    // (outside the tabs group) reserves nothing for it.
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: false,
      insetsBottom: 34,
      insideTabs: false,
      onAccessorySurface: false,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
    });

    expect(metrics.tabBarHeight).toBe(0);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(34);
    expect(metrics.fixedFooterBottom).toBe(34);
  });

  it('keeps the tab bar but no toolbar reserve when no climb is set, even if the accessory is mounted', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: false,
      nativeAccessoryPresented: true,
      measuredTabContentInsetBottom: IN_TAB_INFERRED_BAR_INSET,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.nativeAccessoryVisible).toBe(false); // mounted, but no climb to show
    expect(metrics.scrollBottomPadding).toBe(IN_TAB_INFERRED_BAR_INSET);
    expect(metrics.floatingControlBottom).toBe(IN_TAB_INFERRED_BAR_INSET);
    expect(metrics.fixedFooterBottom).toBe(IN_TAB_INFERRED_BAR_INSET);
  });

  it('keeps scroll tab clearance but not fixed-footer tab clearance inside Material tabs', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      usesNativeTabBar: false,
      insetsBottom: 24,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: false,
      nativeAccessoryPresented: false,
    });

    expect(metrics.tabBarBottom).toBe(24 + MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(24 + MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.fixedFooterBottom).toBe(0);
  });

  it('treats a wall-only climb like any present climb (input is wall-aware)', () => {
    // `hasCurrentClimb` is fed the wall-aware presence (local OR live wall climb)
    // by use-bottom-chrome-metrics, so a wall-only climb routes to the native
    // accessory on glass — exactly like a local climb, never both.
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryPresented: true,
      measuredTabContentInsetBottom: IN_TAB_MEASURED_ACCESSORY_INSET,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
  });

  it('never reports both the JS toolbar and the native accessory as visible at once', () => {
    for (const onAccessorySurface of [true, false]) {
      for (const hasCurrentClimb of [true, false]) {
        for (const nativeAccessoryPresented of [true, false]) {
          const metrics = computeBottomChromeMetrics({
            uiVariant: 'liquidGlass',
            usesNativeTabBar: true,
            // Geometry is irrelevant to this visibility-only total-function test.
            insetsBottom: SYNTHETIC_ROOT_INSET,
            insideTabs: true,
            onAccessorySurface,
            hasCurrentClimb,
            nativeAccessoryPresented,
          });
          expect(metrics.jsQueueToolbarVisible && metrics.nativeAccessoryVisible).toBe(false);
        }
      }
    }
  });

  describe('session list/footer bottoms (folded from InSessionView / PreSessionView)', () => {
    it('docks both to the fixed-footer reserve on Material', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'material',
        usesNativeTabBar: false,
        insetsBottom: 24,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: false,
      });
      expect(metrics.inSessionListBottom).toBe(metrics.fixedFooterBottom);
      expect(metrics.preSessionFooterBottom).toBe(metrics.fixedFooterBottom);
    });

    it('anchors Liquid Glass to the measured in-tab inset and never double-counts the tab bar', () => {
      // iPhone 17 Pro / iOS 26: the glass tab bar extends the IN-TAB inset, so
      // every bottom metric anchors to the measurement rather than adding chrome
      // to it again — and never to the bar-less root inset either.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: ROOT_WINDOW_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        measuredTabContentInsetBottom: IN_TAB_MEASURED_ACCESSORY_INSET,
      });
      // Both consumers clear the same already-composed native tab/accessory
      // region, so equality is the invariant (as established by #3973).
      expect(metrics.preSessionFooterBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
      expect(metrics.fixedFooterBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
      // Native accessory mounted → no JS queue reserve, so the list also rides the measurement.
      expect(metrics.jsQueueReserve).toBe(0);
      expect(metrics.inSessionListBottom).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
    });

    it('adds the JS queue reserve to both Liquid Glass session bottoms when the accessory is unavailable', () => {
      // iOS < 26 / non-glass-capable iPhone: the JS `PersistentQueueBar` tray is an
      // overlay outside the UIKit safe area, so BOTH the in-session list and the
      // pre-session Start capsule have to reserve for it. Before #3967 the footer
      // rode the raw inset and landed under the tray's log-ascent tick.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 34,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: false,
      });
      expect(metrics.inSessionListBottom).toBe(34 + TOOLBAR_RESERVE);
      expect(metrics.preSessionFooterBottom).toBe(34 + TOOLBAR_RESERVE);
    });
  });

  describe('measured in-tab inset (the sampling-point fix)', () => {
    const nativePreSession = (overrides: { measuredTabContentInsetBottom?: number | null; insetsBottom?: number }) =>
      computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: ROOT_WINDOW_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        // Pre-session Record tab: no climb, so no accessory and no JS queue tray.
        hasCurrentClimb: false,
        nativeAccessoryPresented: true,
        ...overrides,
      });

    it('keeps the Start capsule above the native tab bar (the regression this input exists for)', () => {
      // Anchoring to the root inset put the capsule 49pt under the glass bar:
      // the root provider never sees UIKit tab chrome. With the in-tab
      // measurement, every footer clears the bar.
      const metrics = nativePreSession({ measuredTabContentInsetBottom: IN_TAB_INFERRED_BAR_INSET });
      expect(metrics.preSessionFooterBottom).toBe(IN_TAB_INFERRED_BAR_INSET);
      expect(metrics.inSessionListBottom).toBe(IN_TAB_INFERRED_BAR_INSET);
      expect(metrics.scrollBottomPadding).toBe(IN_TAB_INFERRED_BAR_INSET);
      expect(metrics.preSessionFooterBottom).toBeGreaterThanOrEqual(ROOT_WINDOW_INSET + TAB_BAR_HEIGHT);
    });

    it('reconstructs the bar from the root inset while unmeasured (no accessory)', () => {
      const metrics = nativePreSession({ measuredTabContentInsetBottom: null });
      expect(metrics.tabBarBottom).toBe(ROOT_WINDOW_INSET + TAB_BAR_HEIGHT);
      expect(metrics.preSessionFooterBottom).toBe(ROOT_WINDOW_INSET + TAB_BAR_HEIGHT);
    });

    it('reconstructs bar + accessory while unmeasured (accessory visible)', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: ROOT_WINDOW_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        measuredTabContentInsetBottom: null,
      });
      // 34 + 49 + 56 — the reconstruction lands exactly on the device-verified
      // 139, so the pre-measurement frames match the eventual measurement.
      const reconstruction = ROOT_WINDOW_INSET + TAB_BAR_HEIGHT + NATIVE_BOTTOM_ACCESSORY_HEIGHT;
      expect(reconstruction).toBe(IN_TAB_MEASURED_ACCESSORY_INSET);
      expect(metrics.tabBarBottom).toBe(reconstruction);
      expect(metrics.floatingControlBottom).toBe(reconstruction);
      expect(metrics.preSessionFooterBottom).toBe(reconstruction);
    });

    it('rejects a physically impossible measurement (smaller than the root inset)', () => {
      // An in-tab inset can never be below the window's own inset — such a
      // publish (e.g. racing a provider teardown) falls back to reconstruction.
      const metrics = nativePreSession({ measuredTabContentInsetBottom: ROOT_WINDOW_INSET - 14 });
      expect(metrics.tabBarBottom).toBe(ROOT_WINDOW_INSET + TAB_BAR_HEIGHT);
      expect(metrics.preSessionFooterBottom).toBe(ROOT_WINDOW_INSET + TAB_BAR_HEIGHT);
    });

    it('tracks a minimized bar for positioning but floors scroll padding (SYNTHETIC)', () => {
      // minimizeBehavior="onScrollDown": UIKit shrinks the in-tab inset while the
      // bar is minimized. Floating surfaces follow it (a capsule riding the
      // minimizing bar is correct); scroll padding stays at the un-minimized
      // reconstruction so contentContainer padding never shrinks mid-scroll and
      // clamps the offset. The 40pt value is a spec of intended behavior, not a
      // hardware measurement.
      const minimizedInset = 40;
      const metrics = nativePreSession({ measuredTabContentInsetBottom: minimizedInset });
      expect(metrics.tabBarBottom).toBe(minimizedInset);
      expect(metrics.floatingControlBottom).toBe(minimizedInset);
      expect(metrics.preSessionFooterBottom).toBe(minimizedInset);
      expect(metrics.scrollBottomPadding).toBe(ROOT_WINDOW_INSET + TAB_BAR_HEIGHT);
    });

    it('works on home-button devices where the root inset is zero', () => {
      // insetsBottom 0 means the `>= insetsBottom` validity guard rejects
      // nothing — the focus-gated probe is what keeps bad publishes out. A
      // bar-only measurement (0 + 49) and the unmeasured reconstruction agree.
      const measured = nativePreSession({ insetsBottom: 0, measuredTabContentInsetBottom: TAB_BAR_HEIGHT });
      expect(measured.preSessionFooterBottom).toBe(TAB_BAR_HEIGHT);
      const unmeasured = nativePreSession({ insetsBottom: 0, measuredTabContentInsetBottom: null });
      expect(unmeasured.preSessionFooterBottom).toBe(TAB_BAR_HEIGHT);
    });

    it('is ignored on the JS-tab-bar fallback and Material paths', () => {
      for (const uiVariant of ['liquidGlass', 'material'] as const) {
        const withMeasurement = computeBottomChromeMetrics({
          uiVariant,
          usesNativeTabBar: false,
          insetsBottom: ROOT_WINDOW_INSET,
          insideTabs: true,
          onAccessorySurface: true,
          hasCurrentClimb: true,
          nativeAccessoryPresented: false,
          measuredTabContentInsetBottom: IN_TAB_MEASURED_ACCESSORY_INSET,
        });
        const withoutMeasurement = computeBottomChromeMetrics({
          uiVariant,
          usesNativeTabBar: false,
          insetsBottom: ROOT_WINDOW_INSET,
          insideTabs: true,
          onAccessorySurface: true,
          hasCurrentClimb: true,
          nativeAccessoryPresented: false,
          measuredTabContentInsetBottom: null,
        });
        expect(withMeasurement).toEqual(withoutMeasurement);
      }
    });
  });

  describe('pre-session Start capsule clears the floating queue tray (#3967)', () => {
    // The tray band is rebuilt from `floatingContextBarBottom` — the SAME function
    // `ActiveContextBar` positions itself with — rather than from
    // `preSessionFooterBottom`, so this is not a tautology: the two sides come from
    // independent code paths, and moving the tray moves this guard with it instead of
    // leaving it green against a stale band. (The formula lives in theme/layout so this
    // suite can use it without importing the component, which would pull react-native
    // into an otherwise pure test file.) Tray height is `glassSize.hero`, its tallest
    // island.
    //
    // The tray renders at app root in window coordinates while the Start capsule is
    // inside the tab screen, so convert to screen-local coordinates first. An in-flow
    // JS `MaterialTabBar` means the screen's floor already sits `tabBarBottom` above
    // the window bottom (the same assumption `contentInsetBottom` encodes); a native
    // overlaying tab bar or the sidebar shell leaves the screen floor at the window
    // bottom.
    const trayTopAboveScreenFloor = (
      metrics: ReturnType<typeof computeBottomChromeMetrics>,
      usesNativeTabBar: boolean,
    ) => {
      const jsTabBarInFlow = metrics.tabBarHeight > 0 && !usesNativeTabBar;
      const screenFloorAboveWindow = jsTabBarInFlow ? metrics.tabBarBottom : 0;
      return floatingContextBarBottom(metrics.tabBarBottom) + glassSize.hero - screenFloorAboveWindow;
    };

    it('clears the tray on an iOS < 26 / non-glass-capable iPhone', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 34,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: false,
      });
      expect(metrics.jsQueueToolbarVisible).toBe(true);
      expect(metrics.preSessionFooterBottom).toBeGreaterThanOrEqual(trayTopAboveScreenFloor(metrics, false));
    });

    it('clears the tray on an iPad in a narrow split (sidebar without the detail pane)', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 20,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        usesSidebar: true,
        detailPaneOwnsQueue: false,
      });
      expect(metrics.jsQueueToolbarVisible).toBe(true);
      expect(metrics.preSessionFooterBottom).toBeGreaterThanOrEqual(trayTopAboveScreenFloor(metrics, false));
    });
  });

  describe('session-bottom invariants across the whole input matrix', () => {
    // Deliberately exhaustive, including combinations no shell produces today
    // (`usesNativeTabBar` with `insideTabs: false`, say). `computeBottomChromeMetrics`
    // is a pure total function and the callers that feed it — `useNativeTabBar`, the
    // sidebar shell — change shape more often than it does, so pinning the invariants
    // over the full cross-product is what stops a future caller from routing a new
    // combination into an unreserved branch. The realistic configurations are covered
    // by the hand-written cases above; these add the ones nobody thought to enumerate.
    const allInputs = function* () {
      for (const uiVariant of ['liquidGlass', 'material'] as const) {
        for (const usesNativeTabBar of [true, false]) {
          for (const insideTabs of [true, false]) {
            for (const onAccessorySurface of [true, false]) {
              for (const hasCurrentClimb of [true, false]) {
                for (const nativeAccessoryPresented of [true, false]) {
                  for (const usesSidebar of [true, false]) {
                    for (const detailPaneOwnsQueue of [true, false]) {
                      yield {
                        uiVariant,
                        usesNativeTabBar,
                        // The realistic root inset: 83/139 measured values must
                        // pass the `>= insetsBottom` validity guard, and the
                        // realistic device states are pinned separately above.
                        insetsBottom: ROOT_WINDOW_INSET,
                        insideTabs,
                        onAccessorySurface,
                        hasCurrentClimb,
                        nativeAccessoryPresented,
                        usesSidebar,
                        detailPaneOwnsQueue,
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    // Both invariants collect every offending input rather than asserting inside the
    // loop: a bare `expect` in a 256-iteration loop reports only "expected 34 to be
    // 100" and leaves you bisecting by hand for which combination produced it.
    // Every invariant sweeps the measured axis too: null (pre-measurement),
    // the inferred bar-only inset, and the device-verified accessory inset.
    const MEASURED_AXIS = [null, IN_TAB_INFERRED_BAR_INSET, IN_TAB_MEASURED_ACCESSORY_INSET] as const;

    it('always reserves at least the JS queue tray when that tray is visible', () => {
      const unreserved = [];
      for (const measuredTabContentInsetBottom of MEASURED_AXIS) {
        for (const inputs of allInputs()) {
          const metrics = computeBottomChromeMetrics({ ...inputs, measuredTabContentInsetBottom });
          if (!metrics.jsQueueToolbarVisible) continue;
          if (metrics.preSessionFooterBottom < metrics.jsQueueReserve) {
            unreserved.push({ inputs, footer: metrics.preSessionFooterBottom, reserve: metrics.jsQueueReserve });
          }
        }
      }
      expect(unreserved).toEqual([]);
    });

    it('keeps the pre-session footer and the in-session list on the same bottom chrome', () => {
      // Both session surfaces sit under the same tab bar + queue tray, so their
      // bottom offsets must not drift apart — one branch being edited without the
      // other is exactly what caused #3967.
      const drifted = [];
      for (const measuredTabContentInsetBottom of MEASURED_AXIS) {
        for (const inputs of allInputs()) {
          const metrics = computeBottomChromeMetrics({ ...inputs, measuredTabContentInsetBottom });
          if (metrics.preSessionFooterBottom !== metrics.inSessionListBottom) {
            drifted.push({ inputs, footer: metrics.preSessionFooterBottom, list: metrics.inSessionListBottom });
          }
        }
      }
      expect(drifted).toEqual([]);
    });

    it('anchors native-overlay cells to the in-tab inset (measured or reconstructed) exactly once', () => {
      // On the NativeTabs path the in-tab inset covers the 49pt tab bar and, when
      // present, the 56pt BottomAccessory. Every offset must anchor to that value
      // (the measurement when valid, its reconstruction from the root inset when
      // null) exactly once; the only extra bottom reserve this function may add
      // is a JS queue tray in a transitional/fallback state. scrollBottomPadding
      // additionally floors at the reconstruction (the mid-scroll minimize guard).
      const misanchored = [];
      for (const measuredTabContentInsetBottom of MEASURED_AXIS) {
        for (const inputs of allInputs()) {
          if (!inputs.usesNativeTabBar || !inputs.insideTabs || inputs.usesSidebar) continue;
          const metrics = computeBottomChromeMetrics({ ...inputs, measuredTabContentInsetBottom });
          const reconstruction =
            inputs.insetsBottom +
            TAB_BAR_HEIGHT +
            (metrics.nativeAccessoryVisible ? NATIVE_BOTTOM_ACCESSORY_HEIGHT : 0);
          const expectedAnchor = measuredTabContentInsetBottom ?? reconstruction;
          const expectedScroll = Math.max(expectedAnchor, reconstruction) + metrics.jsQueueReserve;
          const expectedBottom = expectedAnchor + metrics.jsQueueReserve;
          if (
            metrics.tabBarBottom !== expectedAnchor ||
            metrics.nativeAccessoryReserve !== 0 ||
            metrics.scrollBottomPadding !== expectedScroll ||
            metrics.floatingControlBottom !== expectedBottom ||
            metrics.fixedFooterBottom !== expectedBottom ||
            metrics.preSessionFooterBottom !== expectedBottom
          ) {
            misanchored.push({ inputs: { ...inputs, measuredTabContentInsetBottom }, metrics, expectedBottom });
          }
        }
      }
      expect(misanchored).toEqual([]);
    });

    it('produces identical metrics for every measured value off the native-overlay path', () => {
      const leaked = [];
      for (const inputs of allInputs()) {
        if (inputs.usesNativeTabBar && inputs.insideTabs && !inputs.usesSidebar) continue;
        const baseline = computeBottomChromeMetrics({ ...inputs, measuredTabContentInsetBottom: null });
        for (const measuredTabContentInsetBottom of MEASURED_AXIS) {
          const metrics = computeBottomChromeMetrics({ ...inputs, measuredTabContentInsetBottom });
          if (JSON.stringify(metrics) !== JSON.stringify(baseline)) {
            leaked.push({ inputs: { ...inputs, measuredTabContentInsetBottom }, metrics, baseline });
          }
        }
      }
      expect(leaked).toEqual([]);
    });
  });

  describe('regular-width iPad sidebar (usesSidebar)', () => {
    it('collapses every bottom offset to the safe-area inset', () => {
      // The left sidebar owns navigation and hosts the queue "now playing" in its
      // footer, so nothing floats at the bottom — every offset is the raw inset.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 20,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        usesSidebar: true,
      });
      expect(metrics.tabBarHeight).toBe(0);
      expect(metrics.tabBarBottom).toBe(20);
      expect(metrics.jsQueueToolbarVisible).toBe(false);
      expect(metrics.nativeAccessoryVisible).toBe(false);
      expect(metrics.jsQueueReserve).toBe(0);
      expect(metrics.nativeAccessoryReserve).toBe(0);
      expect(metrics.scrollBottomPadding).toBe(20);
      expect(metrics.floatingControlBottom).toBe(20);
      expect(metrics.fixedFooterBottom).toBe(20);
      expect(metrics.inSessionListBottom).toBe(20);
      expect(metrics.preSessionFooterBottom).toBe(20);
    });

    it('short-circuits the tab-bar / accessory inputs entirely in sidebar mode', () => {
      // Even with a climb + the native accessory mounted, sidebar mode reserves
      // nothing — it returns before the phone arithmetic runs.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'material',
        usesNativeTabBar: false,
        insetsBottom: 0,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        usesSidebar: true,
      });
      expect(metrics.scrollBottomPadding).toBe(0);
      expect(metrics.floatingControlBottom).toBe(0);
      expect(metrics.nativeAccessoryPresented).toBe(false);
    });

    it('ignores a native-tab signal when the iPad sidebar owns navigation', () => {
      // The shell should not report both today, but keep this total-function
      // combination pinned: the sidebar branch wins before phone tab/accessory
      // arithmetic and therefore adds no native chrome.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: 20,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        usesSidebar: true,
      });
      expect(metrics.tabBarHeight).toBe(0);
      expect(metrics.tabBarBottom).toBe(20);
      expect(metrics.nativeAccessoryPresented).toBe(false);
      expect(metrics.nativeAccessoryReserve).toBe(0);
      expect(metrics.scrollBottomPadding).toBe(20);
      expect(metrics.floatingControlBottom).toBe(20);
      expect(metrics.fixedFooterBottom).toBe(20);
    });

    it('keeps the JS queue toolbar when the sidebar is visible but the detail pane is suppressed', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 20,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        usesSidebar: true,
        detailPaneOwnsQueue: false,
      });

      expect(metrics.tabBarHeight).toBe(0);
      expect(metrics.tabBarBottom).toBe(20);
      expect(metrics.nativeAccessoryPresented).toBe(false);
      expect(metrics.nativeAccessoryVisible).toBe(false);
      expect(metrics.jsQueueToolbarVisible).toBe(true);
      expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
      expect(metrics.nativeAccessoryReserve).toBe(0);
      expect(metrics.scrollBottomPadding).toBe(20 + TOOLBAR_RESERVE);
      expect(metrics.floatingControlBottom).toBe(20 + TOOLBAR_RESERVE);
      expect(metrics.fixedFooterBottom).toBe(TOOLBAR_RESERVE);
      expect(metrics.inSessionListBottom).toBe(20 + TOOLBAR_RESERVE);
      expect(metrics.preSessionFooterBottom).toBe(20 + TOOLBAR_RESERVE);
    });

    it('defaults usesSidebar to false so existing compact call sites are unchanged', () => {
      const withFlag = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: SYNTHETIC_ROOT_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: false,
        nativeAccessoryPresented: false,
        usesSidebar: false,
      });
      const withoutFlag = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: SYNTHETIC_ROOT_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: false,
        nativeAccessoryPresented: false,
      });
      expect(withFlag).toEqual(withoutFlag);
      // No measurement supplied → the native path reconstructs the bar.
      expect(withoutFlag.scrollBottomPadding).toBe(SYNTHETIC_ROOT_INSET + TAB_BAR_HEIGHT);
    });
  });

  describe('connectivity banner height (issue #4862)', () => {
    // A plausible measured card: two lines of copy, an actions row, plus the gap
    // the banner publishes with itself. SYNTHETIC — the banner sizes itself from
    // Dynamic Type, so no single number is device ground truth.
    const BANNER_HEIGHT = 96;

    const nativeTabInputs = {
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: ROOT_WINDOW_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryPresented: false,
      measuredTabContentInsetBottom: IN_TAB_INFERRED_BAR_INSET,
    } as const;

    it('folds the banner into the two offsets it actually occludes', () => {
      const metrics = computeBottomChromeMetrics({ ...nativeTabInputs, connectivityBannerHeight: BANNER_HEIGHT });
      const withoutBanner = computeBottomChromeMetrics(nativeTabInputs);

      expect(metrics.scrollBottomPadding).toBe(withoutBanner.scrollBottomPadding + BANNER_HEIGHT);
      expect(metrics.floatingControlBottom).toBe(withoutBanner.floatingControlBottom + BANNER_HEIGHT);
    });

    it('leaves the docked-footer offsets alone', () => {
      // The banner is an absolute overlay above the floating chrome; a footer
      // docked in flow is not underneath it, so adding the height there would be
      // dead space on every offline screen.
      const metrics = computeBottomChromeMetrics({ ...nativeTabInputs, connectivityBannerHeight: BANNER_HEIGHT });
      const withoutBanner = computeBottomChromeMetrics(nativeTabInputs);

      expect(metrics.fixedFooterBottom).toBe(withoutBanner.fixedFooterBottom);
      expect(metrics.inSessionListBottom).toBe(withoutBanner.inSessionListBottom);
      expect(metrics.preSessionFooterBottom).toBe(withoutBanner.preSessionFooterBottom);
      expect(metrics.tabBarBottom).toBe(withoutBanner.tabBarBottom);
    });

    it('excludes the banner from its own anchor, so it cannot stack on itself', () => {
      const metrics = computeBottomChromeMetrics({ ...nativeTabInputs, connectivityBannerHeight: BANNER_HEIGHT });

      expect(metrics.connectivityBannerBottom).toBe(IN_TAB_INFERRED_BAR_INSET + TOOLBAR_RESERVE);
      expect(metrics.connectivityBannerBottom).toBe(metrics.floatingControlBottom - BANNER_HEIGHT);
      // The anchor is fixed under a re-measure: feeding a taller banner back in
      // must not move where the banner is drawn.
      const taller = computeBottomChromeMetrics({ ...nativeTabInputs, connectivityBannerHeight: BANNER_HEIGHT * 2 });
      expect(taller.connectivityBannerBottom).toBe(metrics.connectivityBannerBottom);
    });

    it('defaults to zero, so every existing call site is unchanged', () => {
      const omitted = computeBottomChromeMetrics(nativeTabInputs);
      const explicitZero = computeBottomChromeMetrics({ ...nativeTabInputs, connectivityBannerHeight: 0 });

      expect(omitted).toEqual(explicitZero);
      expect(omitted.connectivityBannerBottom).toBe(omitted.floatingControlBottom);
    });

    it('clears the banner on the iPad sidebar shell too', () => {
      // The banner is a root sibling with no idea which shell is on screen, so
      // the early-return branch has to fold it in as well — otherwise the iPad
      // FAB sits behind the card.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 20,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryPresented: true,
        usesSidebar: true,
        connectivityBannerHeight: BANNER_HEIGHT,
      });

      expect(metrics.scrollBottomPadding).toBe(20 + BANNER_HEIGHT);
      expect(metrics.floatingControlBottom).toBe(20 + BANNER_HEIGHT);
      expect(metrics.connectivityBannerBottom).toBe(20);
      expect(metrics.fixedFooterBottom).toBe(20);
    });
  });
});
