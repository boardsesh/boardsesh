import { compactErrorMessage } from '@/app/lib/observability/compact-error';

/**
 * Minimum gap between logged failures for the SAME OG route. These routes are
 * hit by crawlers and social-media unfurlers at volume, and a Drizzle-backed
 * route wedging fails every request until it recovers — logging every one of
 * those would turn one outage into thousands of Vercel log events. Not a
 * per-outage latch (unlike the front-door dedupe): an OG route has no
 * "recovered" signal to re-arm on, so this is a plain cooldown instead.
 */
const OG_ERROR_LOG_INTERVAL_MS = 60_000;

const lastLoggedAt = new Map<string, number>();

function shouldLog(route: string): boolean {
  const now = Date.now();
  const last = lastLoggedAt.get(route);
  if (last !== undefined && now - last < OG_ERROR_LOG_INTERVAL_MS) {
    return false;
  }
  lastLoggedAt.set(route, now);
  return true;
}

/**
 * Build the response an OG image route's catch block should return.
 *
 * Two things this fixes over the old per-route `catch` bodies:
 *
 *  - They logged (and returned to the caller) `error.message` verbatim. For
 *    the Drizzle-backed routes that message is `DrizzleQueryError`'s own
 *    message, which embeds the full SQL statement and every bound parameter —
 *    an info leak, since these routes are unauthenticated. The body here is
 *    always the same generic string.
 *  - They logged on every failed render. This throttles to once per route per
 *    {@link OG_ERROR_LOG_INTERVAL_MS}.
 */
export function ogErrorResponse(route: string, error: unknown): Response {
  if (shouldLog(route)) {
    console.error(`[og] ${route} render failed:`, compactErrorMessage(error));
  }

  return new Response('Error generating image', {
    status: 500,
    headers: { 'Cache-Control': 'no-store' },
  });
}
