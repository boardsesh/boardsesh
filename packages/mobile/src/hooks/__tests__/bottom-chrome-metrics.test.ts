import { describe, it, expect } from 'vitest';
import { computeBottomChromeMetrics } from '../bottom-chrome-metrics';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  TAB_BAR_HEIGHT,
  TOOLBAR_RESERVE,
  floatingContextBarBottom,
  glassSize,
} from '../../theme/layout';

// The only device-measured native inset in this suite. Do not turn inferred
// no-accessory/minimized values into product contracts without iOS 26 hardware QA.
const DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET = 139;
// A plausible 34pt home-indicator + 49pt tab-bar arithmetic fixture. This is NOT
// an on-device measurement; it is used only to prove that the pure function treats
// a native UIKit inset as opaque and does not add TAB_BAR_HEIGHT to it.
const SYNTHETIC_NATIVE_SAFE_AREA_INSET = 83;

describe('computeBottomChromeMetrics', () => {
  it('reserves nothing extra outside the tabs group', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: false,
      insetsBottom: 34,
      insideTabs: false,
      onAccessorySurface: false,
      hasCurrentClimb: false,
      nativeAccessoryMounted: false,
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
      insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
    expect(metrics.scrollBottomPadding).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET + TOOLBAR_RESERVE);
    expect(metrics.floatingControlBottom).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET + TOOLBAR_RESERVE);
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
      nativeAccessoryMounted: false,
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
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    // Material clears its taller M3 nav bar (80) — not the iOS 49.
    expect(metrics.scrollBottomPadding).toBe(MATERIAL_TAB_BAR_HEIGHT + MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    expect(metrics.floatingControlBottom).toBe(MATERIAL_TAB_BAR_HEIGHT + MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    expect(metrics.fixedFooterBottom).toBe(MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
  });

  it('anchors every native-tab offset to the UIKit safe-area inset, including the 139pt accessory anchor (#3973)', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      // iPhone 17 Pro / iOS 26 with the BottomAccessory: 34 home indicator +
      // 49 native tab bar + 56 accessory. UIKit has already included all three.
      insetsBottom: DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryMounted: true,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.tabBarHeight).toBe(TAB_BAR_HEIGHT);
    expect(metrics.tabBarBottom).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
    expect(metrics.nativeAccessoryReserve).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
    expect(metrics.floatingControlBottom).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
    expect(metrics.fixedFooterBottom).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
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
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.tabBarHeight).toBe(MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(24 + MATERIAL_TAB_BAR_HEIGHT);
  });

  it('hides both bars on a pushed sub-route even with a climb (glass)', () => {
    // On glass the accessory host unmounts off the top-level tab, so nothing shows;
    // the tab bar still overlays content underneath.
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
      insideTabs: true,
      onAccessorySurface: false,
      hasCurrentClimb: true,
      nativeAccessoryMounted: false,
    });
    expect(metrics.nativeAccessoryVisible).toBe(false);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.tabBarHeight).toBe(TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET);
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
      nativeAccessoryMounted: false,
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
      insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: false,
      nativeAccessoryMounted: true,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.nativeAccessoryVisible).toBe(false); // mounted, but no climb to show
    expect(metrics.scrollBottomPadding).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET);
    expect(metrics.floatingControlBottom).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET);
    expect(metrics.fixedFooterBottom).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET);
  });

  it('keeps scroll tab clearance but not fixed-footer tab clearance inside Material tabs', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      usesNativeTabBar: false,
      insetsBottom: 24,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: false,
      nativeAccessoryMounted: false,
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
      insetsBottom: DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET,
      insideTabs: true,
      onAccessorySurface: true,
      hasCurrentClimb: true,
      nativeAccessoryMounted: true,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
  });

  it('never reports both the JS toolbar and the native accessory as visible at once', () => {
    for (const onAccessorySurface of [true, false]) {
      for (const hasCurrentClimb of [true, false]) {
        for (const nativeAccessoryMounted of [true, false]) {
          const metrics = computeBottomChromeMetrics({
            uiVariant: 'liquidGlass',
            usesNativeTabBar: true,
            // Geometry is irrelevant to this visibility-only total-function test.
            insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
            insideTabs: true,
            onAccessorySurface,
            hasCurrentClimb,
            nativeAccessoryMounted,
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
        nativeAccessoryMounted: false,
      });
      expect(metrics.inSessionListBottom).toBe(metrics.fixedFooterBottom);
      expect(metrics.preSessionFooterBottom).toBe(metrics.fixedFooterBottom);
    });

    it('anchors Liquid Glass to the raw inset and never double-counts the tab bar', () => {
      // iPhone 17 Pro / iOS 26: the glass tab bar already extends the inset, so every
      // bottom metric anchors to the raw value rather than adding chrome again.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryMounted: true,
      });
      expect(metrics.preSessionFooterBottom).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
      expect(metrics.fixedFooterBottom).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
      // Native accessory mounted → no JS queue reserve, so the list also rides the raw inset.
      expect(metrics.jsQueueReserve).toBe(0);
      expect(metrics.inSessionListBottom).toBe(DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET);
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
        nativeAccessoryMounted: false,
      });
      expect(metrics.inSessionListBottom).toBe(34 + TOOLBAR_RESERVE);
      expect(metrics.preSessionFooterBottom).toBe(34 + TOOLBAR_RESERVE);
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
        nativeAccessoryMounted: false,
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
        nativeAccessoryMounted: true,
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
                for (const nativeAccessoryMounted of [true, false]) {
                  for (const usesSidebar of [true, false]) {
                    for (const detailPaneOwnsQueue of [true, false]) {
                      yield {
                        uiVariant,
                        usesNativeTabBar,
                        // Synthetic for the total-function matrix: realistic device
                        // states are pinned separately above.
                        insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
                        insideTabs,
                        onAccessorySurface,
                        hasCurrentClimb,
                        nativeAccessoryMounted,
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
    it('always reserves at least the JS queue tray when that tray is visible', () => {
      const unreserved = [];
      for (const inputs of allInputs()) {
        const metrics = computeBottomChromeMetrics(inputs);
        if (!metrics.jsQueueToolbarVisible) continue;
        if (metrics.preSessionFooterBottom < metrics.jsQueueReserve) {
          unreserved.push({ inputs, footer: metrics.preSessionFooterBottom, reserve: metrics.jsQueueReserve });
        }
      }
      expect(unreserved).toEqual([]);
    });

    it('keeps the pre-session footer and the in-session list on the same bottom chrome', () => {
      // Both session surfaces sit under the same tab bar + queue tray, so their
      // bottom offsets must not drift apart — one branch being edited without the
      // other is exactly what caused #3967.
      const drifted = [];
      for (const inputs of allInputs()) {
        const metrics = computeBottomChromeMetrics(inputs);
        if (metrics.preSessionFooterBottom !== metrics.inSessionListBottom) {
          drifted.push({ inputs, footer: metrics.preSessionFooterBottom, list: metrics.inSessionListBottom });
        }
      }
      expect(drifted).toEqual([]);
    });

    it('never adds native-tab chrome beyond the UIKit safe area', () => {
      // Use the full input cross-product at one synthetic opaque inset and at the
      // on-device 139pt anchor. On the NativeTabs path UIKit's safe area already
      // covers the 49pt tab bar and,
      // when present, the 56pt BottomAccessory. The only extra bottom reserve
      // this function may add is a JS queue tray in a transitional/fallback
      // state; it must never add native chrome again.
      const doubleCounted = [];
      for (const insetsBottom of [SYNTHETIC_NATIVE_SAFE_AREA_INSET, DEVICE_VERIFIED_NATIVE_ACCESSORY_INSET]) {
        for (const inputs of allInputs()) {
          if (!inputs.usesNativeTabBar || !inputs.insideTabs || inputs.usesSidebar) continue;
          const metrics = computeBottomChromeMetrics({ ...inputs, insetsBottom });
          const expectedBottom = insetsBottom + metrics.jsQueueReserve;
          if (
            metrics.tabBarBottom !== insetsBottom ||
            metrics.nativeAccessoryReserve !== 0 ||
            metrics.scrollBottomPadding !== expectedBottom ||
            metrics.floatingControlBottom !== expectedBottom ||
            metrics.fixedFooterBottom !== expectedBottom
          ) {
            doubleCounted.push({ inputs: { ...inputs, insetsBottom }, metrics, expectedBottom });
          }
        }
      }
      expect(doubleCounted).toEqual([]);
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
        nativeAccessoryMounted: true,
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
        nativeAccessoryMounted: true,
        usesSidebar: true,
      });
      expect(metrics.scrollBottomPadding).toBe(0);
      expect(metrics.floatingControlBottom).toBe(0);
      expect(metrics.nativeAccessoryMounted).toBe(false);
    });

    it('keeps the JS queue toolbar when the sidebar is visible but the detail pane is suppressed', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 20,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: true,
        nativeAccessoryMounted: true,
        usesSidebar: true,
        detailPaneOwnsQueue: false,
      });

      expect(metrics.tabBarHeight).toBe(0);
      expect(metrics.tabBarBottom).toBe(20);
      expect(metrics.nativeAccessoryMounted).toBe(false);
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
        insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: false,
        nativeAccessoryMounted: false,
        usesSidebar: false,
      });
      const withoutFlag = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: SYNTHETIC_NATIVE_SAFE_AREA_INSET,
        insideTabs: true,
        onAccessorySurface: true,
        hasCurrentClimb: false,
        nativeAccessoryMounted: false,
      });
      expect(withFlag).toEqual(withoutFlag);
      expect(withoutFlag.scrollBottomPadding).toBe(SYNTHETIC_NATIVE_SAFE_AREA_INSET);
    });
  });
});
