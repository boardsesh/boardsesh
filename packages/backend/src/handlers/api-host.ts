import type { IncomingMessage, ServerResponse } from 'http';
import { parseRequestTarget } from '../lib/request-url';

/**
 * The partner API host (#6981). Must equal API_HOSTNAME in
 * infra/cloudflare/config.ts; scripts/cloudflare-apply.test.ts compares the two.
 */
export const API_HOSTNAME = 'api.boardsesh.com';

/**
 * Everything else the API host answers, as exact method and path pairs. The
 * partner OAuth routes (`partner-auth.ts`) and the `/v1` API
 * (`public-api/router.ts`) are served ahead of this list, and only when their
 * mode is on. `ws.boardsesh.com` stays the only host serving GraphQL, the
 * upload routes and native auth.
 */
const API_HOST_ROUTES: ReadonlyArray<{ method: string; pathname: string }> = [{ method: 'GET', pathname: '/health' }];

/** Reduces a Host header to its lowercase name: no userinfo, trailing dots, or anything after the name. */
function hostnameFromHostHeader(hostHeader: string): string {
  return hostHeader
    .trim()
    .toLowerCase()
    .replace(/^(?:.*@(?=[a-z0-9.-]))?([a-z0-9.-]*).*$/, '$1')
    .replace(/\.+$/, '');
}

/**
 * True when either reading of the Host names the API host. The pattern covers
 * values `new URL` refuses, which still reach an upgrade (`api.boardsesh.com:abc`).
 * `new URL` covers what the pattern cannot decode: percent escapes, tabs and IDNA
 * mappings. Matching too much only refuses a request no real client sends.
 */
export function isApiHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const parsedHostname = parseRequestTarget('/', hostHeader)?.hostname.replace(/\.+$/, '');
  return parsedHostname === API_HOSTNAME || hostnameFromHostHeader(hostHeader) === API_HOSTNAME;
}

function isApiHostRoute(method: string | undefined, pathname: string): boolean {
  return API_HOST_ROUTES.some((route) => route.method === method && route.pathname === pathname);
}

/**
 * Answers 404 for anything the API host does not serve, and reports whether it
 * did. A request on any other host passes through untouched. The 404 matches
 * the dispatcher's own, so the host looks like one that has no such route.
 *
 * WebSocket upgrades never reach this: `verifyClient` in websocket/setup.ts
 * refuses them separately, using `isApiHost`.
 */
export function rejectApiHostRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!isApiHost(req.headers.host) || isApiHostRoute(req.method, pathname)) return false;
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
  return true;
}
