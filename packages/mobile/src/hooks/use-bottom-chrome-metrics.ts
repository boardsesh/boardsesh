import { useMemo } from 'react';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../providers/theme-provider';
import { isTabsChromeRoute } from '../lib/route-segments';
import { useStickyAccessoryPresence } from './use-sticky-accessory-presence';
import { useNativeAccessoryActive, useNativeTabBar } from './use-bottom-accessory';
import { useQueueBarHiddenOnSocial } from '../components/queue-control/use-queue-bar-hidden';
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
  // Treat the player route as chrome-mounted (it's a modal over the tabs) so the
  // accessory + tab-bar metrics don't churn across its open/close — see
  // isTabsChromeRoute. Other root surfaces still read as outside-tabs.
  const insideTabs = isTabsChromeRoute(segments);
  const nativeAccessoryActive = useNativeAccessoryActive();
  const nativeAccessoryMounted = insideTabs && nativeAccessoryActive;
  const nativeTabBar = useNativeTabBar();
  const usesNativeTabBar = insideTabs && nativeTabBar;
  // The flag-gated social hide also drops the JS toolbar's reserved space, so a
  // hidden bar doesn't leave a toolbar-sized gap / over-lift the FABs.
  const jsQueueToolbarSuppressed = useQueueBarHiddenOnSocial();

  return useMemo(
    () =>
      computeBottomChromeMetrics({
        uiVariant: variant,
        usesNativeTabBar,
        insetsBottom: insets.bottom,
        insideTabs,
        hasCurrentClimb,
        nativeAccessoryMounted,
        jsQueueToolbarSuppressed,
      }),
    [
      variant,
      usesNativeTabBar,
      insets.bottom,
      insideTabs,
      hasCurrentClimb,
      nativeAccessoryMounted,
      jsQueueToolbarSuppressed,
    ],
  );
}
