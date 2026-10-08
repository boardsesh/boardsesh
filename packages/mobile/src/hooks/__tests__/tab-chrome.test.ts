import { describe, expect, it } from 'vitest';
import { resolveTabChrome, type TabChromeInputs } from '../tab-chrome';

// An iOS 26 iPhone on the Liquid Glass variant: every native extra available.
const IOS_26_IPHONE: TabChromeInputs = {
  platformOS: 'ios',
  variant: 'liquidGlass',
  glassCapable: true,
  isTablet: false,
  accessoryAvailable: true,
};

// An iOS 18 iPhone: Liquid Glass is the default variant (blur fallback), but the
// device renders no real glass and UIKit has no bottom accessory.
const IOS_18_IPHONE: TabChromeInputs = {
  ...IOS_26_IPHONE,
  glassCapable: false,
  accessoryAvailable: false,
};

describe('resolveTabChrome', () => {
  it('gives an iOS 26 iPhone the native bar with every Liquid Glass extra', () => {
    expect(resolveTabChrome(IOS_26_IPHONE)).toEqual({
      nativeTabBar: true,
      liquidGlassTabBar: true,
      nativeAccessory: true,
    });
  });

  it('gives an iOS 18 iPhone the native bar, without the iOS 26 extras', () => {
    // The HIG Tab bars finding: iOS 18 used to get the JS Material bar here.
    expect(resolveTabChrome(IOS_18_IPHONE)).toEqual({
      nativeTabBar: true,
      liquidGlassTabBar: false,
      nativeAccessory: false,
    });
  });

  it('keeps the native bar but drops the accessory when the glass APIs diverge', () => {
    // Liquid Glass reports available (so the accessory export would work) but the
    // GlassView API does not: the bar is still native, and the accessory must stay
    // off so the JS queue bar is not suppressed for a platter that never mounts.
    expect(resolveTabChrome({ ...IOS_26_IPHONE, glassCapable: false })).toEqual({
      nativeTabBar: true,
      liquidGlassTabBar: false,
      nativeAccessory: false,
    });
  });

  it('keeps the Liquid Glass bar but no accessory when the build lacks the export', () => {
    expect(resolveTabChrome({ ...IOS_26_IPHONE, accessoryAvailable: false })).toEqual({
      nativeTabBar: true,
      liquidGlassTabBar: true,
      nativeAccessory: false,
    });
  });

  it('keeps the JS bar for the Material variant on an iPhone (an explicit choice)', () => {
    expect(resolveTabChrome({ ...IOS_26_IPHONE, variant: 'material' })).toEqual({
      nativeTabBar: false,
      liquidGlassTabBar: false,
      nativeAccessory: false,
    });
  });

  it('keeps tablets on the JS shell at every width', () => {
    for (const device of [IOS_26_IPHONE, IOS_18_IPHONE]) {
      expect(resolveTabChrome({ ...device, isTablet: true })).toEqual({
        nativeTabBar: false,
        liquidGlassTabBar: false,
        nativeAccessory: false,
      });
    }
  });

  it('never picks the native bar off iOS, even on the Liquid Glass variant', () => {
    for (const platformOS of ['android', 'web'] as const) {
      expect(resolveTabChrome({ ...IOS_26_IPHONE, platformOS }).nativeTabBar).toBe(false);
    }
  });

  it('never reports an accessory without the Liquid Glass bar, or that bar without the native bar', () => {
    const bools = [true, false];
    for (const platformOS of ['ios', 'android'] as const)
      for (const variant of ['liquidGlass', 'material'] as const)
        for (const glassCapable of bools)
          for (const isTablet of bools)
            for (const accessoryAvailable of bools) {
              const chrome = resolveTabChrome({ platformOS, variant, glassCapable, isTablet, accessoryAvailable });
              if (chrome.nativeAccessory) expect(chrome.liquidGlassTabBar).toBe(true);
              if (chrome.liquidGlassTabBar) expect(chrome.nativeTabBar).toBe(true);
            }
  });
});
