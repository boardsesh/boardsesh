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

import { isBottomAccessoryAvailable, useNativeAccessoryActive, useNativeTabBar } from '../use-bottom-accessory';

describe('use-bottom-accessory', () => {
  beforeEach(() => {
    cfg.platformOS = 'ios';
    cfg.reactNativeMinor = 82;
    cfg.liquidGlassAvailable = true;
    cfg.glassEffectApiAvailable = true;
    cfg.nativeTabs = {};
    cfg.bottomAccessory = {};
    cfg.variant = 'liquidGlass';
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

  describe('useNativeTabBar', () => {
    it('is true only for the Liquid Glass variant on a glass-capable device', () => {
      const { result, rerender } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(true);

      cfg.variant = 'material';
      rerender();

      expect(result.current).toBe(false);
    });

    it('is false on the Liquid Glass variant when the device is not glass-capable', () => {
      // Older iPhone / Android on Liquid Glass: the JS MaterialTabBar renders instead.
      cfg.liquidGlassAvailable = false;

      const { result } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(false);
    });

    it('is false off iOS even on the Liquid Glass variant', () => {
      cfg.platformOS = 'android';

      const { result } = renderHook(() => useNativeTabBar());

      expect(result.current).toBe(false);
    });
  });

  it('keeps the accessory and the native tab bar consistent when the glass APIs diverge', () => {
    // Liquid Glass reports available but the GlassView API does not: the native tab
    // bar falls back to JS, and the accessory (which lives inside NativeTabs) must
    // agree and stay inactive — otherwise the JS queue toolbar gets suppressed for an
    // accessory that never mounts. Both predicates share useGlassCapability() now.
    cfg.glassEffectApiAvailable = false;

    const tabBar = renderHook(() => useNativeTabBar());
    const accessory = renderHook(() => useNativeAccessoryActive());

    expect(tabBar.result.current).toBe(false);
    expect(accessory.result.current).toBe(false);
  });
});
