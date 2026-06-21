import { describe, it, expect } from 'vitest';
import { computeBottomChromeMetrics } from '../bottom-chrome-metrics';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  TAB_BAR_HEIGHT,
  TOOLBAR_GAP_ABOVE_TABBAR,
  TOOLBAR_RESERVE,
  glassSize,
} from '../../theme/layout';

// Assert the arbitration in terms of the layout constants (not magic numbers) so
// this stays correct when the glass-size ladder is retuned.
const NATIVE_ACCESSORY_RESERVE = glassSize.standard + TOOLBAR_GAP_ABOVE_TABBAR;

describe('computeBottomChromeMetrics', () => {
  it('reserves nothing extra outside the tabs group', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: false,
      insetsBottom: 34,
      insideTabs: false,
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
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
    expect(metrics.scrollBottomPadding).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.floatingControlBottom).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
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

  it('does not pad scroll content for the UIKit-owned native accessory', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      nativeAccessoryMounted: true,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    // UIKit adds the accessory inset itself, so scroll padding is just the tab bar.
    expect(metrics.scrollBottomPadding).toBe(TAB_BAR_HEIGHT);
    // But floating controls must still clear the accessory.
    expect(metrics.nativeAccessoryReserve).toBe(NATIVE_ACCESSORY_RESERVE);
    expect(metrics.floatingControlBottom).toBe(TAB_BAR_HEIGHT + NATIVE_ACCESSORY_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(TAB_BAR_HEIGHT + NATIVE_ACCESSORY_RESERVE);
  });

  it('reserves queue chrome for fixed footers outside the tabs group', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: false,
      insetsBottom: 34,
      insideTabs: false,
      hasCurrentClimb: true,
      nativeAccessoryMounted: false,
    });

    expect(metrics.tabBarHeight).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(34 + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(34 + TOOLBAR_RESERVE);
  });

  it('keeps the tab bar but no toolbar reserve when no climb is set, even if the accessory is mounted', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      insetsBottom: 34,
      insideTabs: true,
      hasCurrentClimb: false,
      nativeAccessoryMounted: true,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.nativeAccessoryVisible).toBe(false); // mounted, but no climb to show
    expect(metrics.scrollBottomPadding).toBe(34 + TAB_BAR_HEIGHT);
    expect(metrics.floatingControlBottom).toBe(34 + TAB_BAR_HEIGHT);
    expect(metrics.fixedFooterBottom).toBe(34 + TAB_BAR_HEIGHT);
  });

  it('keeps scroll tab clearance but not fixed-footer tab clearance inside Material tabs', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      usesNativeTabBar: false,
      insetsBottom: 24,
      insideTabs: true,
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
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      nativeAccessoryMounted: true,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
  });

  it('never reports both the JS toolbar and the native accessory as visible at once', () => {
    for (const hasCurrentClimb of [true, false]) {
      for (const nativeAccessoryMounted of [true, false]) {
        const metrics = computeBottomChromeMetrics({
          uiVariant: 'liquidGlass',
          usesNativeTabBar: true,
          insetsBottom: 0,
          insideTabs: true,
          hasCurrentClimb,
          nativeAccessoryMounted,
        });
        expect(metrics.jsQueueToolbarVisible && metrics.nativeAccessoryVisible).toBe(false);
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
        hasCurrentClimb: true,
        nativeAccessoryMounted: false,
      });
      expect(metrics.inSessionListBottom).toBe(metrics.fixedFooterBottom);
      expect(metrics.preSessionFooterBottom).toBe(metrics.fixedFooterBottom);
    });

    it('anchors Liquid Glass to the raw inset and never double-counts the tab bar', () => {
      // iPhone 17 Pro / iOS 26: the glass tab bar already extends the inset, so the
      // footer is the raw inset — NOT fixedFooterBottom, which would add the bar again.
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: true,
        insetsBottom: 139,
        insideTabs: true,
        hasCurrentClimb: true,
        nativeAccessoryMounted: true,
      });
      expect(metrics.preSessionFooterBottom).toBe(139);
      expect(metrics.preSessionFooterBottom).toBeLessThan(metrics.fixedFooterBottom);
      // Native accessory mounted → no JS queue reserve, so the list also rides the raw inset.
      expect(metrics.jsQueueReserve).toBe(0);
      expect(metrics.inSessionListBottom).toBe(139);
    });

    it('adds only the JS queue reserve to the Liquid Glass in-session list when the accessory is unavailable', () => {
      const metrics = computeBottomChromeMetrics({
        uiVariant: 'liquidGlass',
        usesNativeTabBar: false,
        insetsBottom: 34,
        insideTabs: true,
        hasCurrentClimb: true,
        nativeAccessoryMounted: false,
      });
      expect(metrics.inSessionListBottom).toBe(34 + TOOLBAR_RESERVE);
      expect(metrics.preSessionFooterBottom).toBe(34);
    });
  });
});
