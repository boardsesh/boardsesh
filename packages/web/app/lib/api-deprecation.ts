// Route-handler-only: the counter below reaches `analytics.server`. Importing
// this from a client component should fail at the boundary, not deep inside a
// transitive import.
import 'server-only';

import { NextResponse } from 'next/server';

import { track } from '@/app/lib/analytics.server';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import type { BoardOnlyRouteParameters } from '@/app/lib/types';

/**
 * The Aurora proxy endpoints (`/api/v1/{board}/proxy/{login,saveAscent}`) are
 * retired. Board control, login and tick logging live in the Boardsesh app and
 * speak GraphQL to the backend; nothing this repo ships has called these paths
 * since the GraphQL migration.
 *
 * They are published in the OpenAPI document rendered at /docs, which is
 * indexable and sitemapped, and the document itself is served as a plain file at
 * /openapi.json, so a third party may still be calling them. Rather than 404
 * them outright they answer 410 for one deprecation window, then W-25b (#4443)
 * removes the routes.
 *
 * Two headers, two different transitions:
 *  - `Deprecation` (RFC 9745 §2, an sf-date: "@" + epoch seconds) — the day the
 *    endpoints stopped working, i.e. the day W-25a shipped. It must never be a
 *    future date: RFC 9745 reads a future sf-date as "will become deprecated",
 *    which contradicts the 410 it rides on. `api-deprecation.test.ts` pins both
 *    the literal and the not-in-the-future bound. Note this is the Structured
 *    Fields form, not the superseded `Deprecation: true` draft.
 *  - `Sunset` (RFC 8594 §3, an IMF-fixdate HTTP-date) — when the URL stops
 *    existing and starts answering 404. That is when W-25b lands.
 */
export const AURORA_PROXY_DEPRECATION_DATE = new Date('2026-08-15T00:00:00Z');
export const AURORA_PROXY_SUNSET_DATE = new Date('2026-10-01T00:00:00Z');

/**
 * RFC 9745 §3 wants the `deprecation` link relation to point at something that
 * explains the deprecation, so this is the anchor of the "Retired endpoints"
 * card on /docs (`app/docs/docs-client.tsx`), not the bare page — the two
 * operations are no longer in the Swagger pane, so a reader landing on /docs
 * with no such card would find nothing to read.
 */
export const DEPRECATION_DOCS_URL = absoluteUrl('/docs#retired-endpoints');

/** The only two proxy paths that survive W-25a, both answering 410. */
export type DeprecatedAuroraProxyEndpoint = 'login' | 'saveAscent';

/**
 * Emitted on every call to a retired proxy. W-25b's sign-off reads this number
 * to decide whether removing the URLs is safe: it is the only in-repo channel
 * that outlives a Vercel runtime-log retention window.
 */
export const DEPRECATED_AURORA_PROXY_EVENT = 'Deprecated Aurora Proxy Called';

export function deprecatedAuroraProxyResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Gone: the Aurora proxy endpoints have been retired.',
      documentation: DEPRECATION_DOCS_URL,
    },
    {
      status: 410,
      headers: {
        Deprecation: `@${Math.floor(AURORA_PROXY_DEPRECATION_DATE.getTime() / 1000)}`,
        Sunset: AURORA_PROXY_SUNSET_DATE.toUTCString(),
        Link: `<${DEPRECATION_DOCS_URL}>; rel="deprecation"; type="text/html"`,
        // A 410 is cacheable by default (RFC 9110). These paths took credentials
        // in the request body, so no shared cache should hold a response for them.
        'Cache-Control': 'no-store',
      },
    },
  );
}

/**
 * `@vercel/analytics`'s server `track` copies `user-agent`, `x-forwarded-for`
 * AND `cookie` off whatever headers it is handed straight onto its outbound
 * request to `/_vercel/insights/event`. `saveAscent` callers still send a
 * NextAuth session cookie, so handing it `request.headers` would push a session
 * token into the analytics ingestion path for an endpoint that needs no identity
 * at all. It accepts a plain object as well as a `Headers`, so hand it only the
 * two fields it actually reads for session attribution.
 */
function analyticsHeaders(request: Request): Record<string, string> {
  return {
    'user-agent': request.headers.get('user-agent') ?? '',
    'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
  };
}

/**
 * Builds a route handler that answers 410 and counts the call.
 *
 * The event carries the endpoint name, the board name and the HTTP method —
 * never the request body, which carried Aurora credentials on `login` and a
 * session token on `saveAscent`, and never the caller's cookies. `method` is
 * there because both verbs answer 410: without it a crawler's `GET` and a real
 * integration's `POST` are the same event, and W-25b's sign-off is back to
 * guessing. The board name is lower-cased because the middleware's board check
 * is case-insensitive, so `/api/v1/Kilter/...` reaches this handler and would
 * otherwise split the counter across casing variants.
 *
 * The counter is fired and forgotten, and wrapped, so neither a rejected nor a
 * synchronously-thrown telemetry call can turn a 410 into a 500.
 */
export function deprecatedAuroraProxyRoute(endpoint: DeprecatedAuroraProxyEndpoint) {
  return async function handleDeprecatedAuroraProxy(
    request: Request,
    props: { params: Promise<BoardOnlyRouteParameters> },
  ): Promise<NextResponse> {
    const { board_name: boardName } = await props.params;

    try {
      void track(
        DEPRECATED_AURORA_PROXY_EVENT,
        { endpoint, boardName: boardName.toLowerCase(), method: request.method },
        { headers: analyticsHeaders(request) },
      ).catch(() => {});
    } catch {
      // Telemetry must never break the 410. `.catch` covers a rejected promise;
      // this covers `track` throwing before it ever returns one.
    }

    return deprecatedAuroraProxyResponse();
  };
}
