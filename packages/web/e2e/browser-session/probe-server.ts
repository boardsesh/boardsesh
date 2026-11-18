import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COOKIE_DOMAIN } from './stack';

/**
 * A cookie echo for `cookie-domain.spec.ts`, which asks each engine, with no
 * Boardsesh code in the way, whether a `Secure; Domain=.boardsesh.test` cookie
 * set by one host is stored and sent to its siblings.
 *
 *   /set?name=...   Set-Cookie with the production attributes (`__Secure-`
 *                   prefix, Domain on the parent, Secure, HttpOnly, Lax)
 *   /set-host-only  the same cookie without a Domain
 *   /clear?name=... expires the Domain cookie
 *   /bfcache/<n>    a small cacheable page that records every `pageshow`, for `bfcache.spec.ts`
 *   anything else   answers with the Cookie header the browser sent
 */

/**
 * No `unload` or `beforeunload` handler and no `no-store`: either would make a
 * page ineligible for the back/forward cache whatever the engine allows.
 */
const BACKFORWARD_PAGE = `<!doctype html><meta charset="utf-8"><title>bfcache probe</title>
<p>bfcache probe</p>
<script>
  window.__pageshows = [];
  addEventListener('pageshow', (event) => window.__pageshows.push(event.persisted));
</script>`;

export async function startProbeServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://probe.invalid');
    const name = url.searchParams.get('name') ?? '__Secure-probe';
    const attributes = 'Path=/; Secure; HttpOnly; SameSite=Lax';
    if (url.pathname === '/set') {
      response.setHeader('Set-Cookie', `${name}=1; Domain=${COOKIE_DOMAIN}; Max-Age=3600; ${attributes}`);
    } else if (url.pathname === '/set-host-only') {
      response.setHeader('Set-Cookie', `${name}=1; Max-Age=3600; ${attributes}`);
    } else if (url.pathname.startsWith('/bfcache/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=60' });
      response.end(BACKFORWARD_PAGE);
      return;
    } else if (url.pathname === '/clear') {
      response.setHeader('Set-Cookie', `${name}=; Domain=${COOKIE_DOMAIN}; Max-Age=0; ${attributes}`);
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ host: request.headers.host ?? null, cookie: request.headers.cookie ?? '' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, server };
}
