import { Platform } from 'react-native';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '../providers/theme-provider';
import { useGlassCapability } from './use-glass-capability';
import { useDeviceLayout } from './use-device-layout';

/**
 * Whether the device *can* host `NativeTabs.BottomAccessory` — the pure
 * capability check. The native accessory is tied to the system Liquid Glass tab
 * bar, so it only exists on that path.
 */
export function isBottomAccessoryAvailable(): boolean {
  return Platform.OS === 'ios' && NativeTabs?.BottomAccessory != null && isLiquidGlassAvailable();
}

/**
 * Whether the native iOS 26 Liquid Glass tab bar (`NativeTabs`) is in use right
 * now: the Liquid Glass variant on a glass-capable device. The single canonical
 * predicate for "the native tab bar renders" — everything else (Material, plus
 * Liquid Glass on iOS < 26 / Android) falls back to the JS `Tabs` + `MaterialTabBar`.
 * Drives the tab-bar choice in `_layout` and the tab-bar geometry in
 * `useBottomChromeMetrics`, so the two never disagree about which bar is on screen.
 */
export function useNativeTabBar(): boolean {
  const { variant } = useTheme();
  const glassCapable = useGlassCapability();
  const { widthClass } = useDeviceLayout();
  // The iPad sidebar shell (regular width) renders JS `Tabs` + a glass rail instead
  // of `NativeTabs`, so the native tab bar — and the bottom accessory + tab-bar
  // search role it hosts — is not on screen there. Everything that branches on this
  // predicate (the climb-list search mode, the accessory mount, bottom-chrome
  // geometry) must treat the iPad shell as "no native tab bar", or it reaches for a
  // native search bar / accessory that has no bar to live in (the search field
  // then collides with the floating top chrome).
  if (widthClass === 'regular') return false;
  return variant === 'liquidGlass' && glassCapable;
}

/**
 * Whether the native bottom accessory is actually in use right now. The accessory
 * lives *inside* `NativeTabs`, so it requires the native tab bar to be on screen —
 * gating it on `useNativeTabBar()` (rather than re-deriving from the variant)
 * guarantees the two share the same `useGlassCapability()` check. If they used
 * different `expo-glass-effect` predicates and diverged, the metrics could suppress
 * the JS queue toolbar for an accessory that never actually mounts. On the Material
 * variant / non-capable devices the current climb + tick ride the floating
 * `PersistentQueueBar` instead and this returns false.
 */
export function useNativeAccessoryActive(): boolean {
  return useNativeTabBar() && isBottomAccessoryAvailable();
}
