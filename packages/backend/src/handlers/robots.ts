import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `ws.boardsesh.com` is an API and image host, not a search surface.
 *
 * It served no robots.txt of its own until 2026-09-11 — a request returned only
 * Cloudflare's managed preamble, which carries no `Disallow` — so crawlers
 * treated `/graphql`, `/og/climb` and `/render/*` as fair game. That is not a
 * cheap mistake: the browser app at app.boardsesh.com issues GraphQL against
 * this host, so a crawler rendering the SPA turns one page fetch into a backend
 * query. A 3-minute sample of this service on 2026-09-10 had Applebot issuing
 * 173 of the 436 `/graphql` requests on it.
 *
 * Cloudflare prepends its managed block to whatever the origin returns, so this
 * body is appended to that rather than replacing it.
 */
export const ROBOTS_TXT_BODY = 'User-agent: *\nDisallow: /\n';

/** A day. The answer never varies by request and crawlers re-read it constantly. */
export const ROBOTS_TXT_MAX_AGE_SECONDS = 86400;

export function handleRobotsTxt(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': `public, max-age=${ROBOTS_TXT_MAX_AGE_SECONDS}`,
  });
  // HEAD must carry the same headers and no body.
  res.end(req.method === 'HEAD' ? undefined : ROBOTS_TXT_BODY);
}
