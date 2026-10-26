import { describe, expect, it } from 'vitest';
import { resolveVerticalTabBar, VERTICAL_TAB_BAR_MIN_SIDE_INSET, type VerticalTabBarInputs } from '../vertical-tab-bar';

// An iPhone 17 Pro in portrait, the app's only orientation on a regular iPhone.
const IPHONE_PORTRAIT: VerticalTabBarInputs = {
  platformOS: 'ios',
  isPad: false,
  windowWidth: 402,
  windowHeight: 874,
  windowInsets: { left: 0, right: 0 },
  tabContentSideInset: 0,
};

// iPhone Duo closed: the outer display, 466 x 678pt, rail on the trailing edge.
const DUO_CLOSED: VerticalTabBarInputs = {
  ...IPHONE_PORTRAIT,
  windowWidth: 466,
  windowHeight: 678,
  // INFERRED: the rail plus the side status bar, as on the inner display.
  tabContentSideInset: 84,
};

describe('resolveVerticalTabBar', () => {
  it('reads a portrait iPhone bar as horizontal', () => {
    expect(resolveVerticalTabBar(IPHONE_PORTRAIT)).toBe(false);
    expect(resolveVerticalTabBar({ ...IPHONE_PORTRAIT, tabContentSideInset: null })).toBe(false);
  });

  it("reads iPhone Duo's closed rail from the in-tab side inset", () => {
    expect(resolveVerticalTabBar(DUO_CLOSED)).toBe(true);
  });

  it('reads the rail from the window inset before the first in-tab measurement', () => {
    expect(
      resolveVerticalTabBar({ ...DUO_CLOSED, tabContentSideInset: null, windowInsets: { left: 0, right: 62 } }),
    ).toBe(true);
  });

  it('stays vertical with a climb in the accessory, which grows only the bottom inset', () => {
    // The bottom inset never enters the rule: with the platter it reaches ~73pt in
    // the closed Duo shots, close to the rail's 84.
    expect(resolveVerticalTabBar({ ...DUO_CLOSED, tabContentSideInset: 84 })).toBe(true);
  });

  it("reads the Duo's inner display in landscape as vertical from its shape alone", () => {
    expect(
      resolveVerticalTabBar({
        ...IPHONE_PORTRAIT,
        windowWidth: 951,
        windowHeight: 669,
        tabContentSideInset: null,
      }),
    ).toBe(true);
  });

  it("reads the Duo's inner display in portrait as horizontal", () => {
    expect(resolveVerticalTabBar({ ...IPHONE_PORTRAIT, windowWidth: 669, windowHeight: 951 })).toBe(false);
  });

  it('ignores a side inset below the floor', () => {
    expect(
      resolveVerticalTabBar({ ...IPHONE_PORTRAIT, tabContentSideInset: VERTICAL_TAB_BAR_MIN_SIDE_INSET - 1 }),
    ).toBe(false);
    expect(resolveVerticalTabBar({ ...IPHONE_PORTRAIT, tabContentSideInset: VERTICAL_TAB_BAR_MIN_SIDE_INSET })).toBe(
      true,
    );
  });

  it('keeps iPad and Android out, whatever their geometry', () => {
    const landscapeWithInsets = { windowWidth: 1366, windowHeight: 1024, tabContentSideInset: 84 };
    expect(resolveVerticalTabBar({ ...IPHONE_PORTRAIT, ...landscapeWithInsets, isPad: true })).toBe(false);
    expect(resolveVerticalTabBar({ ...IPHONE_PORTRAIT, ...landscapeWithInsets, platformOS: 'android' })).toBe(false);
  });
});
