import { useEffect } from 'react';
import { reportScreenshotSmokeContent, type ScreenshotSmokeRoute } from '../lib/screenshot-smoke';

type ScreenshotSmokeMarkerProps = {
  route: ScreenshotSmokeRoute;
  /** How much the screen is showing: rows in its list, or lit holds on the board. */
  count: number;
};

/**
 * Tells the E2E gate's smoke that this screen rendered, and how much.
 *
 * A component, not a hook, on purpose: it has to sit INSIDE the screen's
 * rendered tree. A screen that returns nothing, or throws before it gets to its
 * content, then never mounts the marker and never pings, which is the failure
 * the smoke exists to catch. A hook at the top of the screen would keep pinging
 * from a screen that draws nothing.
 *
 * Mount it behind the inlined screenshot-mode check so normal builds strip it:
 *
 *   {process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? <ScreenshotSmokeMarker route="/home" count={rows.length} /> : null}
 *
 * Renders nothing. Pings again whenever the count changes; the orchestrator
 * keeps the largest count it saw. See src/lib/screenshot-smoke.ts.
 */
export function ScreenshotSmokeMarker({ route, count }: ScreenshotSmokeMarkerProps): null {
  useEffect(() => {
    reportScreenshotSmokeContent(route, count);
  }, [route, count]);
  return null;
}
