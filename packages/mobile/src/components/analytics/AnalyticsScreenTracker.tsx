import { useEffect, useRef } from 'react';
import { useSegments } from 'expo-router';
import { trackScreen } from '../../lib/analytics';
import { normalizeScreenPath } from '../../lib/analytics-screen-path';

// Fires a $screen event on every Expo Router navigation, using the route pattern
// (e.g. /climbs/[climbUuid]) rather than the concrete path so PostHog sees one
// screen per route, not one per climb. The lastPath ref dedupes the repeated
// segment emissions Expo Router produces during a transition. Renders nothing.
export function AnalyticsScreenTracker(): null {
  const segments = useSegments();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = normalizeScreenPath(segments);
    if (path === lastPath.current) return;
    lastPath.current = path;
    trackScreen(path);
  }, [segments]);

  return null;
}
