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
const INLINE_NATIVE_ACCESSORY_RESERVE = glassSize.inline + TOOLBAR_GAP_ABOVE_TABBAR;

describe('computeBottomChromeMetrics', () => {
  it('reserves nothing extra outside the tabs group', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      insetsBottom: 34,
      insideTabs: false,
      hasCurrentClimb: false,
      hasRepTimer: false,
      nativeAccessoryHeight: glassSize.standard,
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
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: false,
      nativeAccessoryHeight: glassSize.standard,
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
    expect(metrics.scrollBottomPadding).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.floatingControlBottom).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
  });

  it('does not reserve bottom timer space when a session is active', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: true,
      nativeAccessoryHeight: glassSize.standard,
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.repTimerReserve).toBe(0);
    expect(metrics.jsQueueReserve).toBe(TOOLBAR_RESERVE);
    expect(metrics.scrollBottomPadding).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.floatingControlBottom).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(TAB_BAR_HEIGHT + TOOLBAR_RESERVE);
  });

  it('does not reserve bottom timer space on Material when a session is active', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: true,
      nativeAccessoryHeight: glassSize.standard,
      nativeAccessoryMounted: false,
    });
    expect(metrics.jsQueueToolbarVisible).toBe(true);
    expect(metrics.repTimerReserve).toBe(0);
    expect(metrics.jsQueueReserve).toBe(MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    // Material clears its taller M3 nav bar (80) — not the iOS 49.
    expect(metrics.scrollBottomPadding).toBe(MATERIAL_TAB_BAR_HEIGHT + MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    expect(metrics.floatingControlBottom).toBe(MATERIAL_TAB_BAR_HEIGHT + MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
    expect(metrics.fixedFooterBottom).toBe(MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT);
  });

  it('reserves the docked Material bar when the JS toolbar is visible', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'material',
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: false,
      nativeAccessoryHeight: glassSize.standard,
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
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: false,
      nativeAccessoryHeight: glassSize.standard,
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

  it('does not pad scroll content for a top-header timer above the UIKit-owned native accessory', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: true,
      nativeAccessoryHeight: glassSize.standard,
      nativeAccessoryMounted: true,
    });
    expect(metrics.nativeAccessoryVisible).toBe(true);
    expect(metrics.jsQueueToolbarVisible).toBe(false);
    expect(metrics.jsQueueReserve).toBe(0);
    expect(metrics.repTimerReserve).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(TAB_BAR_HEIGHT);
    expect(metrics.nativeAccessoryReserve).toBe(NATIVE_ACCESSORY_RESERVE);
    expect(metrics.floatingControlBottom).toBe(TAB_BAR_HEIGHT + NATIVE_ACCESSORY_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(TAB_BAR_HEIGHT + NATIVE_ACCESSORY_RESERVE);
  });

  it('tracks inline native accessory height without reserving bottom timer space', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      insetsBottom: 0,
      insideTabs: true,
      hasCurrentClimb: true,
      hasRepTimer: true,
      nativeAccessoryHeight: glassSize.inline,
      nativeAccessoryMounted: true,
    });

    expect(metrics.repTimerReserve).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(TAB_BAR_HEIGHT);
    expect(metrics.nativeAccessoryReserve).toBe(INLINE_NATIVE_ACCESSORY_RESERVE);
    expect(metrics.floatingControlBottom).toBe(TAB_BAR_HEIGHT + INLINE_NATIVE_ACCESSORY_RESERVE);
  });

  it('reserves queue chrome for fixed footers outside the tabs group', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      insetsBottom: 34,
      insideTabs: false,
      hasCurrentClimb: true,
      hasRepTimer: false,
      nativeAccessoryHeight: glassSize.standard,
      nativeAccessoryMounted: false,
    });

    expect(metrics.tabBarHeight).toBe(0);
    expect(metrics.scrollBottomPadding).toBe(34 + TOOLBAR_RESERVE);
    expect(metrics.fixedFooterBottom).toBe(34 + TOOLBAR_RESERVE);
  });

  it('keeps the tab bar but no toolbar reserve when no climb is set, even if the accessory is mounted', () => {
    const metrics = computeBottomChromeMetrics({
      uiVariant: 'liquidGlass',
      insetsBottom: 34,
      insideTabs: true,
      hasCurrentClimb: false,
      hasRepTimer: true,
      nativeAccessoryHeight: glassSize.standard,
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
      insetsBottom: 24,
      insideTabs: true,
      hasCurrentClimb: false,
      hasRepTimer: false,
      nativeAccessoryHeight: glassSize.standard,
      nativeAccessoryMounted: false,
    });

    expect(metrics.tabBarBottom).toBe(24 + MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.scrollBottomPadding).toBe(24 + MATERIAL_TAB_BAR_HEIGHT);
    expect(metrics.fixedFooterBottom).toBe(0);
  });

  it('never reports both the JS toolbar and the native accessory as visible at once', () => {
    for (const hasCurrentClimb of [true, false]) {
      for (const nativeAccessoryMounted of [true, false]) {
        const metrics = computeBottomChromeMetrics({
          uiVariant: 'liquidGlass',
          insetsBottom: 0,
          insideTabs: true,
          hasCurrentClimb,
          hasRepTimer: false,
          nativeAccessoryHeight: glassSize.standard,
          nativeAccessoryMounted,
        });
        expect(metrics.jsQueueToolbarVisible && metrics.nativeAccessoryVisible).toBe(false);
      }
    }
  });
});
