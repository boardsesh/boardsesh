import { useMemo } from 'react';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../providers/theme-provider';
import { isTabsRoute } from '../lib/route-segments';
import { useStickyAccessoryPresence } from './use-sticky-accessory-presence';
import { useNativeAccessoryActive, useNativeTabBar } from './use-bottom-accessory';
import { useDeviceLayout } from './use-device-layout';
import { computeBottomChromeMetrics } from './bottom-chrome-metrics';

/**
 * Reserves and offsets for chrome that floats over scrollable content (the
 * persistent queue toolbar / iOS 26 bottom accessory). Gathers the React inputs
 * and delegates the arithmetic to the pure {@link computeBottomChromeMetrics}.
 */
export function useBottomChromeMetrics() {
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  // Only the *presence* of a current climb matters here — subscribe to the
  // presence-only selector, which flips solely when a climb appears/disappears.
  // This keeps bottom chrome from re-rendering on queue mutations OR on
  // climb-to-climb navigation across every screen that floats it. Wall-aware so a
  // board-presence ("on the wall") climb counts too. Use the same sticky wrapper
  // as the accessory mount gate so the JS-vs-native arbitration tracks what the
  // accessory host actually shows (incl. its brief presence-blip hold).
  const hasCurrentClimb = useStickyAccessoryPresence();
  const { variant } = useTheme();
  const insideTabs = isTabsRoute(segments);
  const nativeAccessoryActive = useNativeAccessoryActive();
  const nativeAccessoryMounted = insideTabs && nativeAccessoryActive;
  const nativeTabBar = useNativeTabBar();
  const usesNativeTabBar = insideTabs && nativeTabBar;
  // Regular-width iPad replaces the bottom tab bar with the left sidebar, so
  // bottom chrome collapses to the safe-area inset (the queue lives in the
  // sidebar footer). Compact width (every iPhone, narrow iPad split) keeps the
  // tab-bar arithmetic above.
  const { widthClass } = useDeviceLayout();
  const usesSidebar = insideTabs && widthClass === 'regular';

  return useMemo(
    () =>
      computeBottomChromeMetrics({
        uiVariant: variant,
        usesNativeTabBar,
        insetsBottom: insets.bottom,
        insideTabs,
        hasCurrentClimb,
        nativeAccessoryMounted,
        usesSidebar,
      }),
    [variant, usesNativeTabBar, insets.bottom, insideTabs, hasCurrentClimb, nativeAccessoryMounted, usesSidebar],
  );
}
