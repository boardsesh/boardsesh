/**
 * Pings for the mobile E2E gate's navigation smoke (docs/mobile-e2e-gate.md).
 *
 * iOS Maestro on this build cannot match the app's own elements, so the smoke
 * cannot ask "is the list on screen?" from outside. Each smoke-visited screen
 * instead tells the orchestrator it has rendered and how much it rendered, and
 * the root crash screen tells it that it mounted. The orchestrator
 * (`scripts/mobile-screenshots.ts --flow smoke`) fails the run on a missing
 * ping, a zero count, or any error ping.
 *
 * Screenshot mode only, and within it only when the orchestrator set
 * `EXPO_PUBLIC_SCREENSHOT_SMOKE_URL` (it does so for the smoke flow alone, so a
 * store capture makes exactly the requests it always has). Every caller sits
 * behind an inlined `process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1'`, the rule
 * `screenshot-mode.ts` documents, so a normal build strips the call sites and
 * this module with them.
 */

/** The screens the smoke visits. Mirrors `SMOKE_ROUTES` in scripts/lib/mobile-smoke.ts. */
export type ScreenshotSmokeRoute = '/home' | '/profile' | '/climbs' | 'play-drawer';

const PING_ATTEMPTS = 3;
const PING_RETRY_DELAY_MS = 2000;
/** Long enough to name the error, short enough for a query string. */
const MAX_ERROR_MESSAGE_LENGTH = 300;

async function deliver(query: string): Promise<void> {
  const smokeUrl = process.env.EXPO_PUBLIC_SCREENSHOT_SMOKE_URL;
  if (!smokeUrl) return;
  // Retried like the home-readiness ping in AnalyticsScreenTracker: a single
  // fire-and-forget fetch loses the signal to any transient hiccup, and a lost
  // ping fails the gate.
  for (let attempt = 0; attempt < PING_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${smokeUrl}?${query}`);
      if (response.ok) return;
    } catch {
      // Retry below.
    }
    if (attempt < PING_ATTEMPTS - 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, PING_RETRY_DELAY_MS));
    }
  }
}

/**
 * How many holds a climb's frame string lights (`p1083r15p1117r12…`, one `p`
 * entry per hold). The play drawer's content count: zero means the board is up
 * with no climb on it.
 */
export function countLitHolds(frames: string): number {
  return frames.match(/p\d+/g)?.length ?? 0;
}

/** A smoke-visited screen rendered, showing `count` rows (or holds, for the board). */
export function reportScreenshotSmokeContent(route: ScreenshotSmokeRoute, count: number): void {
  void deliver(`kind=content&route=${encodeURIComponent(route)}&count=${count}`);
}

/** The root crash screen mounted. */
export function reportScreenshotSmokeError(error: Error): void {
  const message = `${error.name}: ${error.message}`.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  void deliver(`kind=error&message=${encodeURIComponent(message)}`);
}
