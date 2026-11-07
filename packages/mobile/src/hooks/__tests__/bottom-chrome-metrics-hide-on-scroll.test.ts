import { describe, it, expect } from 'vitest';
import { computeBottomChromeMetrics } from '../bottom-chrome-metrics';
import { MATERIAL_MINI_PLAYER_CARD_RESERVE, MATERIAL_TAB_BAR_HEIGHT, TOOLBAR_RESERVE } from '../../theme/layout';

// The Android phone bar that overlays its tab roots so it can hide on scroll.
// INFERRED: a Pixel's gesture-navigation inset; only the arithmetic matters here.
const ANDROID_GESTURE_INSET = 24;
const androidTabRoot = {
  usesNativeTabBar: false,
  insetsBottom: ANDROID_GESTURE_INSET,
  insideTabs: true,
  onAccessorySurface: true,
  hasCurrentClimb: true,
  nativeAccessoryPresented: false,
} as const;
const shownBarTop = ANDROID_GESTURE_INSET + MATERIAL_TAB_BAR_HEIGHT;

describe('jsBarOverlaysContent', () => {
  it('overlays a tab root and moves the screen floor under the bar', () => {
    const metrics = computeBottomChromeMetrics({ ...androidTabRoot, uiVariant: 'material', hideOnScrollTabBar: true });
    expect(metrics.jsBarOverlaysContent).toBe(true);
    // Same bar height, so root overlays stay where they were.
    expect(metrics.tabBarBottom).toBe(shownBarTop);
    expect(metrics.floatingControlBottom).toBe(shownBarTop + MATERIAL_MINI_PLAYER_CARD_RESERVE);
    // Screen-relative footers now clear the bar drawn over the screen.
    expect(metrics.fixedFooterBottom).toBe(shownBarTop + MATERIAL_MINI_PLAYER_CARD_RESERVE);
    expect(metrics.inSessionListBottom).toBe(shownBarTop + MATERIAL_MINI_PLAYER_CARD_RESERVE);
    expect(metrics.preSessionFooterBottom).toBe(shownBarTop + MATERIAL_MINI_PLAYER_CARD_RESERVE);
    // Lists were already padded for the shown bar; the overlay changes nothing there.
    expect(metrics.scrollBottomPadding).toBe(shownBarTop + MATERIAL_MINI_PLAYER_CARD_RESERVE);
  });

  it('is exactly the in-flow bar with the flag off', () => {
    const off = computeBottomChromeMetrics({ ...androidTabRoot, uiVariant: 'material', hideOnScrollTabBar: false });
    const before = computeBottomChromeMetrics({ ...androidTabRoot, uiVariant: 'material' });
    expect(off).toEqual(before);
    expect(off.jsBarOverlaysContent).toBe(false);
    expect(off.fixedFooterBottom).toBe(MATERIAL_MINI_PLAYER_CARD_RESERVE);
  });

  it('keys on the drawn bar, not the variant: Android on Liquid Glass overlays too', () => {
    const metrics = computeBottomChromeMetrics({
      ...androidTabRoot,
      uiVariant: 'liquidGlass',
      hideOnScrollTabBar: true,
    });
    expect(metrics.jsBarOverlaysContent).toBe(true);
    expect(metrics.fixedFooterBottom).toBe(shownBarTop + TOOLBAR_RESERVE);
    expect(metrics.inSessionListBottom).toBe(shownBarTop + TOOLBAR_RESERVE);
    expect(metrics.preSessionFooterBottom).toBe(shownBarTop + TOOLBAR_RESERVE);
  });

  it('keeps a pushed sub-route in flow', () => {
    const metrics = computeBottomChromeMetrics({
      ...androidTabRoot,
      uiVariant: 'material',
      onAccessorySurface: false,
      hideOnScrollTabBar: true,
    });
    expect(metrics.jsBarOverlaysContent).toBe(false);
    expect(metrics.fixedFooterBottom).toBe(0);
  });

  it('never overlays on a compact tablet, which keeps its in-flow bar', () => {
    // The hook resolves `hideOnScrollTabBar` to false on every tablet
    // (`resolveHideOnScrollTabBar`), so a compact tablet's JS bar matches the
    // flag-off numbers.
    const compactTablet = computeBottomChromeMetrics({
      ...androidTabRoot,
      uiVariant: 'material',
      hideOnScrollTabBar: false,
    });
    expect(compactTablet.jsBarOverlaysContent).toBe(false);
    expect(compactTablet.fixedFooterBottom).toBe(MATERIAL_MINI_PLAYER_CARD_RESERVE);
  });

  it('never overlays on the sidebar shell or under the native tab bar', () => {
    const sidebar = computeBottomChromeMetrics({
      ...androidTabRoot,
      uiVariant: 'material',
      usesSidebar: true,
      detailPaneOwnsQueue: false,
      hideOnScrollTabBar: true,
    });
    expect(sidebar.jsBarOverlaysContent).toBe(false);
    const native = computeBottomChromeMetrics({
      ...androidTabRoot,
      uiVariant: 'liquidGlass',
      usesNativeTabBar: true,
      hideOnScrollTabBar: true,
    });
    expect(native.jsBarOverlaysContent).toBe(false);
  });
});
