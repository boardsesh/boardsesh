import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `ws.boardsesh.com` served no robots.txt of its own until 2026-09-11 — a
 * request returned only Cloudflare's managed preamble, which carries no
 * `Disallow` — so crawlers treated `/graphql` as fair game. That is not a cheap
 * mistake: the browser app at app.boardsesh.com issues GraphQL against this
 * host, so a crawler rendering the SPA turns one page fetch into a backend
 * query. A 3-minute sample of this service on 2026-09-10 had Applebot issuing
 * 173 of the 436 `/graphql` requests on it.
 *
 * **A deny-list, not `Disallow: /` with carve-outs.** This host is mostly an
 * image CDN, and blanket-blocking it would silently break things a crawler
 * legitimately needs:
 * - `/og/climb` is the climb share card. `buildOgBoardRenderUrl`
 *   (`packages/web/app/components/board-renderer/util.ts`) emits it as an
 *   absolute URL into every climb page's `og:image` and `twitter:image`, so an
 *   unfurler that honours robots would drop the preview.
 * - `/render/board` is the climb page's LCP image, and `/render/geometry` the
 *   traced art behind it.
 * - `/static/*` serves avatars, gym logos, gym photos and beta thumbnails, all
 *   of which appear in `<img>` on indexable pages.
 *
 * Blocking those by omission is exactly the failure `packages/web/app/robots.ts`
 * already guards against on www with its `/api/og/` and
 * `/api/internal/board-render` allows. Listing what to refuse instead means a
 * new image route is crawlable by default and only a new *API* route needs a
 * line here. The expensive render paths are edge-cached at Cloudflare anyway
 * (see the og and board-render cache rules in `infra/cloudflare/config.ts`), so
 * crawler traffic to them is largely absorbed before it reaches this process.
 *
 * Cloudflare prepends its managed block to whatever the origin returns, so this
 * body is appended to that rather than replacing it.
 */
export const DISALLOWED_ROBOTS_PATHS = [
  // The measured cost, and never useful to a crawler.
  '/graphql',
  // Every JSON API, including the PostHog proxy and the upload endpoints.
  '/api/',
  // Prefix-matches /health/db too.
  '/health',
  // The Kilter OAuth handoff. GET routes, but not content.
  '/board-credentials/',
] as const;

export const ROBOTS_TXT_BODY = `User-agent: *\n${DISALLOWED_ROBOTS_PATHS.map((path) => `Disallow: ${path}`).join('\n')}\n`;

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
