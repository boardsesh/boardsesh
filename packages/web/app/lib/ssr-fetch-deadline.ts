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
