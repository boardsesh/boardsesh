import { useEffect, useRef } from 'react';
import { useSegments } from 'expo-router';
import { trackScreen } from '../../lib/analytics';
import { normalizeScreenPath } from '../../lib/analytics-screen-path';
import { useAnalyticsConsent } from '../../lib/consent-hooks';

// Reports every Expo Router navigation using the route pattern (e.g.
// /climbs/[climbUuid]) rather than the concrete path, so PostHog sees one screen
// per route, not one per climb. The lastPath ref dedupes the repeated segment
// emissions Expo Router produces during a transition; it stays FIRST because it
// is a ref compare with no SDK call, so intermediate renders never reach the
// session gate inside trackScreen. Whether a navigation actually emits $screen is
// that gate's call — see lib/analytics-screen-session-gate.ts. Renders nothing.
export function AnalyticsScreenTracker(): null {
  const segments = useSegments();
  const granted = useAnalyticsConsent();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = normalizeScreenPath(segments);
    if (!granted) {
      // A new consent/account epoch must retry even if the route did not change.
      // trackScreen's session gate still suppresses repeats in the same session.
      lastPath.current = null;
    } else if (path !== lastPath.current) {
      lastPath.current = path;
      trackScreen(path);
    }
  }, [segments, granted]);

  return null;
}
