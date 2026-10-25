import 'server-only';

/**
 * Wall-clock ceiling for a server-render fetch to the GraphQL backend.
 *
 * Without one, an SSR `await fetch(...)` inherits undici's default: no timeout
 * at all. A backend that accepts the socket and then never answers holds the
 * render open until the client, the proxy, or the platform gives up — which on
 * an unattended surface (an iframe on a gym's website, a TV in a gym) means a
 * blank frame for minutes instead of the retry screen the page already knows
 * how to render.
 *
 * 3000 ms matches the deadline #4461 put on the home page's `popularBoardConfigs`
 * / `recentBetaLinks` reads and on the front-door `createCachedGraphQLQuery`
 * calls. One number across every SSR backend read beats a bespoke value per
 * surface: these are all "render something within a page-load budget or degrade",
 * and a caller that genuinely needs longer should say so at its own call site.
 *
 * What this does NOT cover: Next deliberately strips the signal when it
 * revalidates a STALE cache entry (`patch-fetch.js`, "don't pass through signal
 * when revalidating" → `signal: isStale ? undefined : signal`), and the render
 * waits on that revalidate promise before the response closes
 * (`app-render.js` puts it on `options.waitUntil`; `render-result.js`'s `pipeTo`
 * awaits `this.waitUntil` before closing the stream). So a warm entry rolling
 * over against a slow backend can still hold a response open past this deadline.
 * The deadline bounds the COLD render; the stale-revalidate hole is upstream.
 */
export const SSR_BACKEND_FETCH_TIMEOUT_MS = 3000;

/**
 * Ceiling for per-user GraphQL reads (`executeAuthenticatedGraphQL`): profile,
 * playlist, gym and session-adjacent pages. Longer than the anonymous 3 s
 * because these reads are not shared-cache warm. Sentry, 14 days, backend
 * /graphql spans: playlist p99 419 ms / max 2.65 s, session p99 1.06 s,
 * profile statistics p99 924 ms / max 2.29 s, gym max 6.66 s. 5 s is over 4x
 * every p99 and still lets a slow-but-alive backend answer (#4680). A caller
 * that needs another number passes its own signal.
 *
 * `executeGraphQLInternal` defaults to {@link SSR_BACKEND_FETCH_TIMEOUT_MS}.
 *
 * A timeout rejects the read. Not every caller degrades: `getProfileData` and
 * the profile page let it reach the error boundary (a 5xx), and callers that
 * map "no row" to a 404 (`fetchGymBySlug`, the session detail read) rethrow it
 * via {@link isDeadlineError} so a slow backend is never served as "not found".
 */
export const SSR_AUTHENTICATED_FETCH_TIMEOUT_MS = 5000;

/**
 * True when `error` is the rejection an expired `AbortSignal.timeout` (or an
 * aborted fetch) produces, including when a client wraps it in `cause`.
 */
export function isDeadlineError(error: unknown, depth = 0): boolean {
  // Cause chains are short; the cap stops a circular `cause` from recursing forever.
  if (depth > 5) return false;
  // Structural, not `instanceof Error`: a DOMException is not an Error in every runtime.
  if (typeof error !== 'object' || error === null) return false;
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return isDeadlineError(cause, depth + 1);
}
