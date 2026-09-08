import { useEffect, useRef } from 'react';
import { useSegments } from 'expo-router';
import { trackScreen } from '../../lib/analytics';
import { normalizeScreenPath } from '../../lib/analytics-screen-path';

// Reports every Expo Router navigation using the route pattern (e.g.
// /climbs/[climbUuid]) rather than the concrete path, so PostHog sees one screen
// per route, not one per climb. The lastPath ref dedupes the repeated segment
// emissions Expo Router produces during a transition; it stays FIRST because it
// is a ref compare with no SDK call, so intermediate renders never reach the
// session gate inside trackScreen. Whether a navigation actually emits $screen is
// that gate's call — see lib/analytics-screen-session-gate.ts. Renders nothing.
export function AnalyticsScreenTracker(): null {
  const segments = useSegments();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = normalizeScreenPath(segments);
    if (path === lastPath.current) return;
    lastPath.current = path;
    trackScreen(path);
    // Screenshot mode: tell the capture orchestrator we reached home directly (not
    // via Metro's `$screen /home` log, which intermittently stops forwarding mid-run
    // with ERR_STREAM_UNABLE_TO_PIPE). A few retried GETs to its readiness server —
    // a single fire-and-forget fetch loses the signal to any transient hiccup, and
    // this ping only matters when the Metro marker is already lost. The inlined
    // guard dead-strips this in normal builds.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && path === '/home') {
      const readyUrl = process.env.EXPO_PUBLIC_SCREENSHOT_READY_URL;
      if (readyUrl) {
        const pingUntilDelivered = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const readinessResponse = await fetch(readyUrl);
              if (readinessResponse.ok) return;
            } catch {
              // Retry below.
            }
            if (attempt < 2) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
            }
          }
        };
        void pingUntilDelivered();
      }
    }
  }, [segments]);

  return null;
}
