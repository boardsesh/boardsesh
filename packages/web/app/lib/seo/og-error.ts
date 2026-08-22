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
 *    an info leak, since these routes are unauthenticated. The response body
 *    never echoes the error.
 *  - They logged on every failed render. This throttles to once per route per
 *    {@link OG_ERROR_LOG_INTERVAL_MS}.
 *
 * The response itself is a 302 to `/opengraph-image` (the existing DB-free
 * branded card, `app/opengraph-image.tsx`) rather than a 500. Unfurlers
 * (Slack, Discord, iMessage, Twitter/X) render nothing on a 5xx and then cache
 * that failed scrape for days, so the next real crawl of the same URL can be
 * far off — a degraded-but-present card beats a blank embed for that whole
 * window. The 60s `s-maxage` lets the CDN answer a burst of scraper retries
 * during a brownout without sending each one at the DB, while staying short
 * enough to pick up the real image again shortly after recovery.
 *
 * This must NEVER route through `createOgImageHeaders`: its versioned branch
 * sets a one-year immutable `Cache-Control`, which would pin this fallback
 * for a year instead of the 60s window above.
 */
export function ogErrorResponse(route: string, error: unknown): Response {
  if (shouldLog(route)) {
    console.error(`[og] ${route} render failed:`, compactErrorMessage(error));
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/opengraph-image',
      'Cache-Control': 'public, max-age=0, s-maxage=60',
      'CDN-Cache-Control': 'public, s-maxage=60',
      'Vercel-CDN-Cache-Control': 'public, s-maxage=60',
    },
  });
}
