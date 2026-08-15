import { NextResponse } from 'next/server';

import { track } from '@/app/lib/analytics.server';
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
 *  - `Deprecation` (RFC 9745 §2, an sf-date: "@" + epoch seconds) — when the
 *    endpoint stopped working. That is now. Note this is the Structured Fields
 *    form, not the superseded `Deprecation: true` draft.
 *  - `Sunset` (RFC 8594 §3, an IMF-fixdate HTTP-date) — when the URL stops
 *    existing and starts answering 404. That is when W-25b lands.
 */
export const AURORA_PROXY_DEPRECATION_DATE = new Date('2026-08-17T00:00:00Z');
export const AURORA_PROXY_SUNSET_DATE = new Date('2026-10-01T00:00:00Z');

const DEPRECATION_DOCS_URL = 'https://www.boardsesh.com/docs';

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
 * Builds a route handler that answers 410 and counts the call.
 *
 * Only the endpoint name and the board name are recorded — never the request
 * body, which carried Aurora credentials on `login` and a session token on
 * `saveAscent`. The counter is fired and forgotten so a telemetry outage can
 * never turn a 410 into a 500.
 */
export function deprecatedAuroraProxyRoute(endpoint: DeprecatedAuroraProxyEndpoint) {
  return async function handleDeprecatedAuroraProxy(
    request: Request,
    props: { params: Promise<BoardOnlyRouteParameters> },
  ): Promise<NextResponse> {
    const { board_name: boardName } = await props.params;

    void track(DEPRECATED_AURORA_PROXY_EVENT, { endpoint, boardName }, { headers: request.headers }).catch(() => {});

    return deprecatedAuroraProxyResponse();
  };
}
