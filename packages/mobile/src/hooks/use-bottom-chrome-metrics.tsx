import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSegments } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../providers/theme-provider';
import { isAccessorySurfaceRoute, isTabsChromeRoute } from '../lib/route-segments';
import { useNativeTabContentInsetBottom } from '../lib/native-tab-content-inset-store';
import { useConnectivityBannerHeight } from '../lib/connectivity-banner-inset-store';
import { useStickyAccessoryPresence } from './use-sticky-accessory-presence';
import { isBottomAccessoryAvailable, useNativeTabBar } from './use-bottom-accessory';
import { useDeviceLayout } from './use-device-layout';
import { computeBottomChromeMetrics, type BottomChromeMetrics } from './bottom-chrome-metrics';
import { shouldThrowOnMissingProvider } from './bottom-chrome-provider-gate';
import { resolveDetailPaneSurface } from '../theme/size-class';
import { SIDEBAR_WIDTH } from '../theme/layout';
import { reportHandledError } from '../lib/error-reporting';

/**
 * Gathers the React inputs for the bottom-chrome geometry and delegates the
 * arithmetic to the pure {@link computeBottomChromeMetrics}. Called ONCE — by
 * {@link BottomChromeMetricsProvider} — so the ~9 input-hook subscriptions (and
 * the sticky-presence grace timer) run a single time for the whole app instead
 * of once per consumer. Consumers read the shared, memoized result through
 * {@link useBottomChromeMetrics}.
 */
function useComputedBottomChromeMetrics(): BottomChromeMetrics {
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
  // The TAB BAR is present on every tab route, including pushed sub-routes (session
  // detail keeps it). The player route counts too (it's a modal over the live tabs)
  // so the tab-bar metrics don't churn across its open/close — see isTabsChromeRoute.
  const insideTabs = isTabsChromeRoute(segments);
  // The JS queue toolbar (Android / iOS < 26) only shows on a top-level tab page, plus
  // occluded under the player. Keep it separate from `insideTabs` so a pushed sub-route
  // still reserves tab-bar height but no longer reserves toolbar space for a bar that's
  // gone. The NATIVE accessory is wider — see `nativeAccessoryPresented` below.
  const onAccessorySurface = isAccessorySurfaceRoute(segments);
  // The single canonical "is the native tab bar on screen?" predicate. The bottom
  // accessory lives INSIDE that bar, so derive its mount from the SAME call plus the
  // plain availability check — exactly what useNativeAccessoryActive() does — rather
  // than calling useNativeTabBar() a second time. Sharing the one call (instead of
  // re-deriving the accessory from the variant) is what guarantees the two never
  // disagree about which bar is up; see use-bottom-accessory. It also drops the
  // duplicate useTheme/useGlassCapability/useDeviceLayout subscriptions the second
  // useNativeTabBar() call used to pull in.
  const nativeTabBar = useNativeTabBar();
  const nativeAccessoryActive = nativeTabBar && isBottomAccessoryAvailable();
  // `onAccessorySurface`, NOT the host-mount gate — the two genuinely differ here, and
  // conflating them costs a dead gap. The host stays MOUNTED on pushed sub-routes (that
  // is #5055's fix, see `isAccessoryHostRoute`), but UIKit does not PRESENT the platter
  // there: it is on screen at a tab root and gone once you push, device-checked on the
  // playlist route. This reserve is about what the climber can actually see, so it has
  // to follow presentation. Keying it on the mount gate made `nativeChromeFallback` add
  // accessory height on every sub-route, and `scrollBottomPadding` takes
  // `Math.max(measured, fallback)` — so the measured inset could not correct it and
  // every pushed screen got dead space under its last row (#3776's failure shape).
  const nativeAccessoryPresented = onAccessorySurface && nativeAccessoryActive;
  const usesNativeTabBar = insideTabs && nativeTabBar;
  // Regular-width iPad replaces the bottom tab bar with the left sidebar. Only
  // widths that also mount the selected-climb detail pane suppress the floating
  // queue toolbar; tight regular windows keep that toolbar because the pane is
  // intentionally absent there.
  const { width: windowWidth } = useWindowDimensions();
  const { widthClass } = useDeviceLayout();
  const usesSidebar = insideTabs && widthClass === 'regular';
  const detailPaneOwnsQueue =
    usesSidebar && resolveDetailPaneSurface({ width: windowWidth, widthClass, sidebarWidth: SIDEBAR_WIDTH }) === 'pane';
  // This provider samples the ROOT safe-area inset (window / home indicator
  // only). The in-tab inset — the one UIKit extends with the native tab bar +
  // accessory — is published by NativeTabContentInsetProbe from inside the
  // focused tab; see the sampling-point contract in bottom-chrome-metrics.ts.
  const measuredTabContentInsetBottom = useNativeTabContentInsetBottom();
  // The connectivity banner (issue #4862) is a root-level absolute overlay above
  // ALL of this chrome, on every route. It measures itself and publishes through
  // another module store for the same reason the in-tab probe does: `Toast` reads
  // the same number from ABOVE this provider. `0` while no banner is showing, so
  // the arithmetic below is unchanged in the ordinary case.
  const connectivityBannerHeight = useConnectivityBannerHeight();

  return useMemo(
    () =>
      computeBottomChromeMetrics({
        uiVariant: variant,
        usesNativeTabBar,
        insetsBottom: insets.bottom,
        insideTabs,
        onAccessorySurface,
        hasCurrentClimb,
        nativeAccessoryPresented,
        usesSidebar,
        detailPaneOwnsQueue,
        measuredTabContentInsetBottom,
        connectivityBannerHeight,
      }),
    [
      variant,
      usesNativeTabBar,
      insets.bottom,
      insideTabs,
      onAccessorySurface,
      hasCurrentClimb,
      nativeAccessoryPresented,
      usesSidebar,
      detailPaneOwnsQueue,
      measuredTabContentInsetBottom,
      connectivityBannerHeight,
    ],
  );
}

const BottomChromeMetricsContext = createContext<BottomChromeMetrics | null>(null);

/**
 * Computes the bottom-chrome reserves/offsets (the geometry for chrome that
 * floats over scrollable content — the persistent queue toolbar / iOS 26 bottom
 * accessory) ONCE and shares the memoized result with every consumer. Mount it
 * once near the tab root (app/_layout.tsx), below the theme + queue providers and
 * inside the router so `useSegments()` resolves.
 *
 * Before this hoist, ~25 always/often-mounted consumers (every tab list, the
 * snackbars/FABs, the session views) each re-ran the same ~9 input-hook
 * subscriptions on every render and each spun up its own presence grace timer,
 * and every one re-rendered on every raw input fire (e.g. a geometry-neutral
 * navigation). Now the inputs are read a single time and the value only changes
 * when the derived geometry actually does, so a consumer re-renders only on a real
 * geometry change. (#2565 — completes the "hoist into one provider" remedy after
 * the queue-context split already isolated the live-session presence/stat churn.)
 */
export function BottomChromeMetricsProvider({ children }: { children: ReactNode }) {
  const metrics = useComputedBottomChromeMetrics();
  return <BottomChromeMetricsContext.Provider value={metrics}>{children}</BottomChromeMetricsContext.Provider>;
}

// Last-resort geometry for the bug-only case where a consumer renders OUTSIDE the
// provider in a release build. Everything collapses to the no-chrome baseline.
// It is never returned in dev or tests — those still throw so a mount-tree misuse
// is caught before it ships. See useBottomChromeMetrics for why a release build
// must not throw.
export const FALLBACK_BOTTOM_CHROME_METRICS: BottomChromeMetrics = computeBottomChromeMetrics({
  uiVariant: 'material',
  usesNativeTabBar: false,
  insetsBottom: 0,
  insideTabs: false,
  onAccessorySurface: false,
  hasCurrentClimb: false,
  nativeAccessoryPresented: false,
});

// Report the out-of-provider fallback at most ONCE per app launch. A misplaced
// consumer re-renders constantly, so without this guard the release fallback would
// flood error tracking with one report per frame. Module-level so it survives
// across every hook call in a launch.
let hasReportedMissingProviderFallback = false;

/**
 * Bottom-chrome reserves and offsets for the current route, computed once by
 * {@link BottomChromeMetricsProvider}. The return shape is unchanged from before
 * the provider hoist, so consumers stay exactly as they were — they just read a
 * shared value instead of each recomputing it.
 *
 * A consumer outside the provider is a mount-tree bug: it throws in dev and tests
 * (gated through {@link shouldThrowOnMissingProvider} so the release path stays
 * testable) so it's caught before shipping. But a release build must NEVER throw
 * here — the queue/undo snackbars once rendered above the provider, and the throw
 * white-screened every install that took that OTA. So production falls back to the
 * conservative {@link FALLBACK_BOTTOM_CHROME_METRICS} and keeps running instead of
 * crashing the whole app — while reporting the misuse once so it's still visible in
 * error tracking rather than silently masked.
 */
export function useBottomChromeMetrics(): BottomChromeMetrics {
  const metrics = useContext(BottomChromeMetricsContext);
  if (metrics) return metrics;
  if (shouldThrowOnMissingProvider()) {
    throw new Error('useBottomChromeMetrics must be used within BottomChromeMetricsProvider');
  }
  if (!hasReportedMissingProviderFallback) {
    hasReportedMissingProviderFallback = true;
    // OTA-safe: reportHandledError no-ops when tracking is off, and downgrades /
    // filters per the noise policy otherwise.
    reportHandledError(new Error('useBottomChromeMetrics rendered outside BottomChromeMetricsProvider'), {
      tags: { source: 'bottom-chrome-fallback' },
    });
  }
  return FALLBACK_BOTTOM_CHROME_METRICS;
}
