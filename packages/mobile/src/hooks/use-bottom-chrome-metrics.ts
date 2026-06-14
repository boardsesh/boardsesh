import { useMemo } from 'react';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHasActiveClimb } from '../providers/queue-provider';
import { useTheme } from '../providers/theme-provider';
import { isTabsRoute } from '../lib/route-segments';
import { glassSize } from '../theme/layout';
import { useNativeAccessoryActive, useNativeAccessoryPlacement } from './use-bottom-accessory';
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
  // climb-to-climb navigation across every screen that floats it.
  const hasCurrentClimb = useHasActiveClimb();
  const { variant } = useTheme();
  const insideTabs = isTabsRoute(segments);
  const nativeAccessoryActive = useNativeAccessoryActive();
  const nativeAccessoryPlacement = useNativeAccessoryPlacement();
  const nativeAccessoryMounted = insideTabs && nativeAccessoryActive;
  const nativeAccessoryHeight = nativeAccessoryPlacement === 'inline' ? glassSize.inline : glassSize.standard;

  return useMemo(
    () =>
      computeBottomChromeMetrics({
        uiVariant: variant,
        insetsBottom: insets.bottom,
        insideTabs,
        hasCurrentClimb,
        hasRepTimer: false,
        nativeAccessoryHeight,
        nativeAccessoryMounted,
      }),
    [variant, insets.bottom, insideTabs, hasCurrentClimb, nativeAccessoryHeight, nativeAccessoryMounted],
  );
}
