import { useEffect } from 'react';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomChromeMetrics } from '../hooks/use-bottom-chrome-metrics';
import type { BottomChromeMetrics } from '../hooks/bottom-chrome-metrics';
import { isTabsRoute } from '../lib/route-segments';
import { publishToastBottomOffset } from '../lib/toast-offset-store';
import { spacing } from '../theme/tokens';

type ToastOffsetInputs = {
  metrics: Pick<BottomChromeMetrics, 'floatingControlBottom' | 'connectivityBannerBottom'>;
  /** Root (window) bottom inset. */
  insetsBottom: number;
  /** Whether the route is inside the (tabs) group proper. */
  onTabsRoute: boolean;
};

/**
 * Where a toast floats. On a tab route: the shared `floatingControlBottom` plus
 * the 8pt gap the queue snackbars leave, so it clears the rendered tab bar, a
 * queue bar or platter only while one shows, the rest pill and the banner.
 *
 * Off the tabs proper — including `/play` and `/onboarding`, which the metrics
 * count as tab chrome so the bar geometry doesn't churn under them — no bar is
 * visible, so the toast sits on the root inset and clears only the
 * connectivity banner. The banner's height is the gap between the two anchors
 * the metrics already expose, never a constant.
 */
export function computeToastBottomOffset({ metrics, insetsBottom, onTabsRoute }: ToastOffsetInputs): number {
  if (onTabsRoute) return metrics.floatingControlBottom + spacing[2];
  const connectivityBannerClearance = metrics.floatingControlBottom - metrics.connectivityBannerBottom;
  return insetsBottom + connectivityBannerClearance + spacing[2];
}

/**
 * Publishes the toast offset for `Toast`, which renders above this provider.
 * Mount ONCE inside `BottomChromeMetricsProvider`, at the root (outside the
 * tabs), so `useSafeAreaInsets()` is the window's inset. Renders nothing.
 */
export function ToastOffsetPublisher() {
  const metrics = useBottomChromeMetrics();
  const insets = useSafeAreaInsets();
  const onTabsRoute = isTabsRoute(useSegments());
  const offset = computeToastBottomOffset({ metrics, insetsBottom: insets.bottom, onTabsRoute });
  useEffect(() => {
    publishToastBottomOffset(offset);
  }, [offset]);
  return null;
}
