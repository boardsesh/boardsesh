import { describe, expect, it } from 'vitest';
import { resolveCurrentClimbSurface, type CurrentClimbSurfaceInputs } from '../current-climb-surface';

// An iOS 26 iPhone on Liquid Glass: native bar and accessory.
const IPHONE: CurrentClimbSurfaceInputs = {
  isTablet: false,
  widthClass: 'compact',
  windowWidth: 402,
  nativeTabBar: true,
  nativeAccessory: true,
  phoneSplit: false,
};

// An iOS 26 iPad on Liquid Glass: UIKit sidebar (or top tab bar) and the accessory.
const NATIVE_IPAD: CurrentClimbSurfaceInputs = {
  ...IPHONE,
  isTablet: true,
  widthClass: 'regular',
  windowWidth: 1376,
};

// The JS tablet shell: an Android tablet, Expo web, or an iPad on Material.
const JS_TABLET: CurrentClimbSurfaceInputs = {
  ...NATIVE_IPAD,
  nativeTabBar: false,
  nativeAccessory: false,
};

describe('resolveCurrentClimbSurface', () => {
  it('keeps the iPhone on the accessory, and on the floating bar without it', () => {
    expect(resolveCurrentClimbSurface(IPHONE)).toEqual({ sidebarShell: false, home: 'nativeAccessory' });
    expect(resolveCurrentClimbSurface({ ...IPHONE, nativeAccessory: false })).toEqual({
      sidebarShell: false,
      home: 'floatingBar',
    });
  });

  // iPad mini portrait, 11" portrait, mini landscape, 11" landscape, 13" landscape.
  it.each([744, 834, 1133, 1210, 1376])('puts the native iPad climb in the accessory at %ipt', (windowWidth) => {
    expect(resolveCurrentClimbSurface({ ...NATIVE_IPAD, windowWidth })).toEqual({
      sidebarShell: false,
      home: 'nativeAccessory',
    });
  });

  it('floats the bar on a native iPad without the iOS 26 accessory, like an iOS 18 iPhone', () => {
    expect(resolveCurrentClimbSurface({ ...NATIVE_IPAD, nativeAccessory: false })).toEqual({
      sidebarShell: false,
      home: 'floatingBar',
    });
  });

  it('keeps the JS tablet shell pane where it fits, and the floating bar where it does not', () => {
    expect(resolveCurrentClimbSurface({ ...JS_TABLET, windowWidth: 1280 })).toEqual({
      sidebarShell: true,
      home: 'detailPane',
    });
    // 744 - 96 rail - 320 pane leaves the list under its 400pt floor.
    expect(resolveCurrentClimbSurface({ ...JS_TABLET, windowWidth: 744 })).toEqual({
      sidebarShell: true,
      home: 'floatingBar',
    });
    // A tablet in a narrow split renders the phone UI: no rail, no pane.
    expect(resolveCurrentClimbSurface({ ...JS_TABLET, widthClass: 'compact', windowWidth: 500 })).toEqual({
      sidebarShell: false,
      home: 'floatingBar',
    });
  });

  it("gives the iPhone Duo's split to its pane and accessory, never the floating bar", () => {
    expect(
      resolveCurrentClimbSurface({ ...IPHONE, windowWidth: 951, phoneSplit: true, nativeAccessory: false }).home,
    ).toBe('nativeAccessory');
  });

  it('never floats the bar over a mounted accessory, and never calls the native iPad the sidebar shell', () => {
    const bools = [true, false];
    for (const isTablet of bools)
      for (const widthClass of ['compact', 'regular'] as const)
        for (const windowWidth of [402, 744, 1024, 1376])
          for (const nativeTabBar of bools)
            for (const nativeAccessory of bools)
              for (const phoneSplit of bools) {
                // The accessory lives inside the native bar (`resolveTabChrome`).
                if (nativeAccessory && !nativeTabBar) continue;
                const surface = resolveCurrentClimbSurface({
                  isTablet,
                  widthClass,
                  windowWidth,
                  nativeTabBar,
                  nativeAccessory,
                  phoneSplit,
                });
                if (nativeAccessory) expect(surface.home).toBe('nativeAccessory');
                if (nativeTabBar) {
                  expect(surface.sidebarShell).toBe(false);
                  expect(surface.home).not.toBe('detailPane');
                }
                if (surface.home === 'detailPane') expect(surface.sidebarShell).toBe(true);
              }
  });
});
