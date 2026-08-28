// Cloudflare Pages Function for app.boardsesh.com — turns a missing asset back
// into a 404.
//
// Why this exists. `_redirects` ends with `/* /index.html 200` because Expo
// Router needs every deep link to serve the exported shell. That catch-all also
// answers asset URLs: a request for a chunk that is not in the deployment gets
// the HTML shell with a 200. `_headers` then stamps
// `Cache-Control: public, max-age=31536000, immutable` on it, because that rule
// matches on `/_expo/*` — the path — and knows nothing about what was served.
//
// The result is worse than a 404. The browser refuses to execute an HTML
// `<script>` (`X-Content-Type-Options: nosniff`), so React never mounts and
// #root stays empty with no error that names the cause; and both the Cloudflare
// edge and the user's browser now hold that HTML under the chunk's URL for a
// year. A reload does not clear it.
//
// Pages `_redirects` cannot express this: it supports 301/302/303/307/308 and
// 200-rewrites, not 404. So the check has to run in code.
//
// Scope is deliberately narrow. `_routes.json` limits this Function to the three
// asset prefixes, so the shell, the PWA manifest and every SPA route are still
// served straight from static assets with no Worker in the path.

/** Path prefixes the export serves as real files, never as SPA routes. */
const ASSET_PREFIXES = ['/_expo/', '/assets/', '/wasm/'] as const;

/**
 * The subset of {@link ASSET_PREFIXES} that `_headers` marks immutable. `/wasm/`
 * is deliberately absent: those filenames are fixed, so the binary must
 * revalidate or a deploy would be masked by a stale cached copy.
 *
 * Kept in sync with `_headers` by immutable-prefix-parity.test.ts — this list
 * exists only as a safety net (see below), and a copy of a caching policy that
 * nothing checks is a copy that drifts.
 */
const IMMUTABLE_PREFIXES = ['/_expo/', '/assets/'] as const;

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The slice of the Pages Functions context this middleware actually uses. */
type AssetMiddlewareContext = {
  request: Request;
  next: () => Promise<Response>;
};

function hasAssetPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname.startsWith(prefix));
}

export async function onRequest(context: AssetMiddlewareContext): Promise<Response> {
  const { pathname } = new URL(context.request.url);

  // Not an asset path — `_routes.json` should not have routed it here at all,
  // so this is just the honest passthrough for a widened include list.
  if (!hasAssetPrefix(pathname, ASSET_PREFIXES)) return context.next();

  const response = await context.next();

  // The SPA fallback answering an asset URL. Nothing under these prefixes is
  // ever legitimately HTML, so this is unambiguous.
  if (/^text\/html/i.test(response.headers.get('content-type') ?? '')) {
    return new Response(`Not found: ${pathname}\n`, {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        // The whole point: a 404 that gets cached is the same bug again.
        'cache-control': 'no-store',
      },
    });
  }

  // Safety net, not the primary mechanism. `_headers` is what sets the immutable
  // cache policy, and it is expected to apply to this response too — but a
  // Function in the path is exactly the kind of change that could quietly stop
  // that, and silently losing `immutable` on a ~10MB bundle would cost every
  // user a re-download on every visit. Re-assert it only if it went missing, so
  // in the normal case this returns the upstream response untouched. The
  // deploy's `entry chunk serves as immutable JavaScript` smoke is the alarm if
  // both this and `_headers` ever fail.
  if (hasAssetPrefix(pathname, IMMUTABLE_PREFIXES)) {
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (!/immutable/i.test(cacheControl)) {
      const headers = new Headers(response.headers);
      headers.set('cache-control', IMMUTABLE_CACHE_CONTROL);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  return response;
}

export const assetMiddlewareInternals = {
  ASSET_PREFIXES,
  IMMUTABLE_PREFIXES,
  IMMUTABLE_CACHE_CONTROL,
};
