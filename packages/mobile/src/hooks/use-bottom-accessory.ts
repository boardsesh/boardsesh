import { useMemo } from 'react';
import { Platform } from 'react-native';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '../providers/theme-provider';
import { useGlassCapability } from './use-glass-capability';
import { useDeviceLayout } from './use-device-layout';
import { resolveTabChrome, type TabChrome } from './tab-chrome';

/**
 * Whether the device *can* host `NativeTabs.BottomAccessory` — the pure
 * capability check. The native accessory is an iOS 26 UIKit feature
 * (`UITabBarController.bottomAccessory`), so it only exists there.
 */
export function isBottomAccessoryAvailable(): boolean {
  return Platform.OS === 'ios' && NativeTabs?.BottomAccessory != null && isLiquidGlassAvailable();
}

/**
 * Which tab chrome is on screen, resolved once from the variant, the device and
 * the iOS version. Every consumer (the tab layout, bottom-chrome metrics, toasts,
 * the climbs search mode, onboarding tips) reads this one answer, so a native
 * accessory is never assumed where it does not mount. See `resolveTabChrome`.
 */
export function useTabChrome(): TabChrome {
  const { variant } = useTheme();
  const glassCapable = useGlassCapability();
  const { isTablet } = useDeviceLayout();
  return useMemo(
    () =>
      resolveTabChrome({
        platformOS: Platform.OS,
        variant,
        glassCapable,
        isTablet,
        accessoryAvailable: isBottomAccessoryAvailable(),
      }),
    [variant, glassCapable, isTablet],
  );
}

/**
 * Whether the native UIKit tab bar (`NativeTabs`) is the bottom bar on screen:
 * the Liquid Glass variant on any iPhone, iOS 18 included. Everything else
 * (Material, Android, the tablet shell) uses the JS `Tabs` + `MaterialTabBar`.
 * Drives the tab-bar choice in `_layout` and the tab-bar geometry in
 * `useBottomChromeMetrics`, so the two never disagree about which bar is up.
 */
export function useNativeTabBar(): boolean {
  return useTabChrome().nativeTabBar;
}

/**
 * Whether the native bar is the iOS 26 Liquid Glass bar, with the separated
 * search tab (Climbs as a lone magnifier) and minimize-on-scroll.
 */
export function useLiquidGlassTabBar(): boolean {
  return useTabChrome().liquidGlassTabBar;
}

/**
 * Whether the native bottom accessory is actually in use right now. It lives
 * inside the iOS 26 bar, so it needs both the Liquid Glass bar and the
 * accessory export. Everywhere else, including the native bar on iOS 18, the
 * current climb + tick ride the floating `PersistentQueueBar` instead.
 */
export function useNativeAccessoryActive(): boolean {
  return useTabChrome().nativeAccessory;
}
