// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const cfg = vi.hoisted(() => ({
  platformOS: 'ios' as 'ios' | 'android',
  reactNativeMinor: 82 as number | undefined,
  liquidGlassAvailable: true,
  // The two expo-glass-effect probes are tracked separately so a test can model
  // them diverging (Liquid Glass available, GlassView API not).
  glassEffectApiAvailable: true,
  nativeTabs: {} as unknown,
  bottomAccessory: {} as unknown,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  // 'regular' models the tablet sidebar shell (no native tab bar); 'compact' is
  // every phone and the default for these variant/capability tests.
  widthClass: 'compact' as 'compact' | 'regular',
  // Tablet in a narrow split: compact width but still a tablet, which the shell
  // keeps on JS Tabs (never NativeTabs). Independent of widthClass so this case is
  // expressible; a 'regular' width always implies a tablet too.
  isTablet: false,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return cfg.platformOS;
    },
    get constants() {
      return { reactNativeVersion: { minor: cfg.reactNativeMinor } };
    },
  },
}));

vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => cfg.liquidGlassAvailable,
  isGlassEffectAPIAvailable: () => cfg.glassEffectApiAvailable,
}));

vi.mock('expo-router/unstable-native-tabs', () => ({
  get NativeTabs() {
    if (cfg.nativeTabs == null) {
      return cfg.nativeTabs;
    }

    return {
      BottomAccessory: cfg.bottomAccessory,
    };
  },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: cfg.variant }),
}));

vi.mock('../use-device-layout', () => ({
  // A 'regular' width only ever resolves on a tablet, so isTablet is true there; the
  // explicit cfg.isTablet covers the tablet-in-a-narrow-split (compact) case.
  useDeviceLayout: () => ({
    widthClass: cfg.widthClass,
    expanded: false,
    isTablet: cfg.widthClass === 'regular' || cfg.isTablet,
  }),
}));

import {
  isBottomAccessoryAvailable,
  useLiquidGlassTabBar,
  useNativeAccessoryActive,
  useNativeTabBar,
} from '../use-bottom-accessory';

describe('use-bottom-accessory', () => {
  it('keeps native search when the glass bar has no accessory export', () => {
    cfg.bottomAccessory = null;
    const { result } = renderHook(() => ({ search: useLiquidGlassTabBar(), accessory: useNativeAccessoryActive() }));
    expect(result.current).toEqual({ search: true, accessory: false });
  });

  beforeEach(() => {
    cfg.platformOS = 'ios';
    cfg.reactNativeMinor = 82;
    cfg.liquidGlassAvailable = true;
    cfg.glassEffectApiAvailable = true;
    cfg.nativeTabs = {};
    cfg.bottomAccessory = {};
    cfg.variant = 'liquidGlass';
    cfg.widthClass = 'compact';
    cfg.isTablet = false;
  });

  it('uses the native BottomAccessory export as the capability check', () => {
    expect(isBottomAccessoryAvailable()).toBe(true);
  });

  it('does not require React Native minor 82 or newer', () => {
    cfg.reactNativeMinor = 81;

    expect(isBottomAccessoryAvailable()).toBe(true);
  });

  it('does not require the React Native minor version to be present', () => {
    cfg.reactNativeMinor = undefined;

    expect(isBottomAccessoryAvailable()).toBe(true);
  });

  it('returns false outside iOS', () => {
    cfg.platformOS = 'android';

    expect(isBottomAccessoryAvailable()).toBe(false);
  });

  it('returns false when Liquid Glass is unavailable', () => {
    cfg.liquidGlassAvailable = false;

    expect(isBottomAccessoryAvailable()).toBe(false);
  });

  it('returns false when the native accessory export is missing', () => {
    cfg.bottomAccessory = null;

    expect(isBottomAccessoryAvailable()).toBe(false);
  });

  it('returns false when the NativeTabs export is missing', () => {
    cfg.nativeTabs = null;

    expect(isBottomAccessoryAvailable()).toBe(false);
  });

  it('returns false when the NativeTabs export is undefined', () => {
    cfg.nativeTabs = undefined;

    expect(isBottomAccessoryAvailable()).toBe(false);
  });

  it('only reports the native accessory active for the Liquid Glass variant', () => {
    const { result, rerender } = renderHook(() => useNativeAccessoryActive());

    expect(result.current).toBe(true);

    cfg.variant = 'material';
    rerender();

    expect(result.current).toBe(false);
  });

  it('does not report the native accessory active when the capability is unavailable', () => {
    cfg.platformOS = 'android';

    const { result } = renderHook(() => useNativeAccessoryActive());

    expect(result.current).toBe(false);
  });

  it('does not report the native accessory active on the iPad sidebar shell', () => {
    // The regular-width iPad shell has no native tab bar, so the accessory that
    // lives inside it must be inactive even on a glass-capable device.
    cfg.widthClass = 'regular';

    const { result } = renderHook(() => useNativeAccessoryActive());

    expect(result.current).toBe(false);
  });

  describe('useNativeTabBar', () => {
    it('is true for the Liquid Glass variant and false for Material', () => {
      const { result, rerender } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(true);

      cfg.variant = 'material';
      rerender();

      expect(result.current).toBe(false);
    });

    it('is true on an iOS 18 iPhone on the Liquid Glass variant (HIG Tab bars)', () => {
      // No real glass and no accessory below iOS 26, but the system tab bar still
      // belongs on screen; it used to fall back to the JS Material bar here.
      cfg.liquidGlassAvailable = false;
      cfg.glassEffectApiAvailable = false;

      const { result } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(true);
    });

    it('is false off iOS even on the Liquid Glass variant', () => {
      cfg.platformOS = 'android';

      const { result } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(false);
    });

    it('uses native tabs on a regular-width iPad', () => {
      cfg.isTablet = true;
      cfg.widthClass = 'regular';
      const { result } = renderHook(() => useNativeTabBar());
      expect(result.current).toBe(true);
    });

    it('keeps native tabs when an iPad enters a narrow split', () => {
      cfg.isTablet = true;
      cfg.widthClass = 'compact';
      const { result } = renderHook(() => useNativeTabBar());
      expect(result.current).toBe(true);
    });

    it('is false on an Android tablet (Material variant) — the shell rail carries nav', () => {
      // Android resolves the Material variant and is never glass-capable, so it was
      // already false; the tablet shell also renders JS Tabs at every width. Either way
      // the native glass tab bar / bottom accessory never mounts on an Android tablet.
      cfg.platformOS = 'android';
      cfg.variant = 'material';
      cfg.glassEffectApiAvailable = false;
      cfg.isTablet = true;
      cfg.widthClass = 'regular';

      const { result } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(false);
    });
  });

  it('keeps the accessory off when the glass APIs diverge, while the bar stays native', () => {
    // Liquid Glass reports available (so the accessory export alone would say yes)
    // but the GlassView API does not: the bar is the classic native bar, and the
    // accessory must stay inactive — otherwise the JS queue toolbar gets suppressed
    // for an accessory that never mounts. All three read one useTabChrome() answer.
    cfg.glassEffectApiAvailable = false;

    const tabBar = renderHook(() => useNativeTabBar());
    const liquidGlass = renderHook(() => useLiquidGlassTabBar());
    const accessory = renderHook(() => useNativeAccessoryActive());

    expect(isBottomAccessoryAvailable()).toBe(true);
    expect(tabBar.result.current).toBe(true);
    expect(liquidGlass.result.current).toBe(false);
    expect(accessory.result.current).toBe(false);
  });

  describe('useLiquidGlassTabBar', () => {
    it('is true on an iOS 26 iPhone and false on iOS 18', () => {
      const { result, rerender } = renderHook(() => useLiquidGlassTabBar());

      expect(result.current).toBe(true);

      cfg.liquidGlassAvailable = false;
      cfg.glassEffectApiAvailable = false;
      rerender();

      expect(result.current).toBe(false);
    });

    it('uses the glass native tab bar on a capable iPad', () => {
      cfg.isTablet = true;

      const { result } = renderHook(() => useLiquidGlassTabBar());

      expect(result.current).toBe(true);
    });
  });

  it('does not report the native accessory active on an iOS 18 iPhone', () => {
    cfg.liquidGlassAvailable = false;
    cfg.glassEffectApiAvailable = false;

    const { result } = renderHook(() => useNativeAccessoryActive());

    expect(result.current).toBe(false);
  });
});
