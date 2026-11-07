import { useEffect } from 'react';
import { useSegments } from 'expo-router';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useAssistiveTechnologyEnabled } from '../../hooks/use-assistive-technology-enabled';
import { useKeyboardHeight } from '../../hooks/use-keyboard-height';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { isAccessoryHiddenRoute, isTopLevelTabRoute } from '../../lib/route-segments';
import { hideOnScrollGateOpen } from '../../lib/tab-bar-visibility';
import { configureTabBarVisibility, resetTabBarVisibility } from '../../lib/tab-bar-visibility-store';

/**
 * Opens and closes the hide-on-scroll gate for the Android nav bar and shows the
 * bar again on every route change (a tab switch included). Mount once at the
 * root, inside `BottomChromeMetricsProvider`. Renders nothing.
 *
 * Wherever the bar does not overlay content (iOS, tablets, the flag off, pushed
 * sub-routes) `jsBarOverlaysContent` is false, the gate stays shut and no
 * keyboard listener is registered.
 */
export function TabBarVisibilityController() {
  const { jsBarOverlaysContent } = useBottomChromeMetrics();
  const segments = useSegments();
  const assistiveTechnology = useAssistiveTechnologyEnabled();
  const keyboardOpen = useKeyboardHeight(jsBarOverlaysContent) > 0;
  const reduceMotion = useReduceMotion();
  const enabled = hideOnScrollGateOpen({
    barOverlaysContent: jsBarOverlaysContent,
    topLevelTab: isTopLevelTabRoute(segments),
    accessoryHiddenRoute: isAccessoryHiddenRoute(segments),
    assistiveTechnology,
    keyboardOpen,
  });
  const routeKey = segments.join('/');

  useEffect(() => {
    configureTabBarVisibility({ enabled, reduceMotion });
  }, [enabled, reduceMotion]);

  useEffect(() => {
    resetTabBarVisibility();
  }, [routeKey]);

  return null;
}
