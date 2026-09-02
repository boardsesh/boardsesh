/**
 * Pure sampling rules behind `src/instrument.ts`.
 *
 * `instrument.ts` calls `Sentry.init()` at module load (it has to — OpenTelemetry
 * must patch http/postgres/redis before anything else imports them), so it can't
 * be imported from a test. The decision logic lives here instead, as pure
 * functions over a structural view of Sentry's sampling context.
 *
 * There is a near-identical path parser in
 * `packages/web/app/lib/observability/sentry-tracing.ts`. They are deliberately
 * not shared: `instrument.ts` runs before the OTel patching and every import it
 * adds is a chance to load a module too early. If a third service needs these
 * rules, extract then.
 */

/**
 * ---------------------------------------------------------------------------
 * Span budget. Re-derive this before changing any rate below.
 * ---------------------------------------------------------------------------
 *
 * Measured over the 7 days to 2026-09-01:
 *
 *   boardsesh-web      12,422 requests   (1 replica,  us-west2)
 *   boardsesh-backend  3,371,614 requests (5 replicas)   <- 260x web
 *
 * Monthly:  3,371,614 / 7 * 30 = ~14,450,000 backend requests/month.
 *
 * A sampled request emits roughly 4 spans (the server transaction plus its
 * db.query / http.client / redis children), so at 100% the backend alone would
 * be ~58M spans/month. The system target is <= 3M spans/month, i.e. a budget of
 * ~750,000 sampled backend requests/month, i.e. a blended rate of
 *
 *   750,000 / 14,450,000 = ~0.052
 *
 * The rates below hit that by rationing the one path that is 260x everything
 * else. Expected mix and its cost:
 *
 *   /graphql        ~85%  12.28M * 0.01 = ~123,000 sampled
 *   zero-rated      ~10%   1.45M * 0     =        0
 *   /og/climb        ~1%    145k * 0.05 =   ~7,000 sampled
 *   everything else  ~4%    578k * 0.10 =  ~58,000 sampled
 *                                        ----------------
 *                                          ~188,000 sampled/month
 *                                          * 4 spans = ~750,000 spans/month
 *
 * Plus ~53,000 from web and a rounding error from the scheduler: ~0.8M
 * spans/month, ~3.5x under budget.
 *
 * The load-bearing assumption is that /graphql dominates. Solving
 * 0.01 + 0.09 * f_other <= 0.052 for the share of traffic landing in the 0.1
 * "everything else" bucket gives f_other <= ~0.46. So the budget holds while
 * fewer than ~46% of backend requests are non-GraphQL and non-zero-rated. If a
 * new REST surface ever pushes past that, it needs its own rate here.
 */

/** Paths whose transactions are worth nothing and would drown everything else. */
const ZERO_RATE_PATH_PREFIXES = [
  // Avatars, gym logos, gym photos, beta-link thumbnails (server.ts). Object
  // storage reads with no application logic in them.
  '/static/',
  // The PostHog reverse proxy. A trace of "we forwarded an analytics batch"
  // duplicates PostHog's own ingestion metrics. Trailing slash on purpose: it
  // mirrors the router's own test (`pathname.startsWith('/api/posthog/')` in
  // server.ts), so a future `/api/posthog-preferences` cannot be silently
  // zero-rated by a prefix this list never meant to claim.
  '/api/posthog/',
];

const ZERO_RATE_PATHS = new Set([
  // The public board image renderer, and its internal alias. Cached hard at
  // Cloudflare; the interesting latency is in the WASM render, not the request.
  '/render/board',
  '/api/internal/board-render',
  // Railway health probes. Fixed interval, forever, never varies.
  '/health',
  '/health/db',
]);

/** GraphQL — the 85% of backend traffic that has to be rationed. See the budget above. */
const GRAPHQL_PATH = '/graphql';
const GRAPHQL_SAMPLE_RATE = 0.01;

/** Climb OG share cards. Low volume, but slow enough (image render) to be worth watching. */
const OG_CLIMB_PATH = '/og/climb';
const OG_CLIMB_SAMPLE_RATE = 0.05;

/** Everything else: /join/*, /integrations/*, the REST surface. */
export const BACKEND_DEFAULT_SAMPLE_RATE = 0.1;

/**
 * Hosts (and relative paths) that may receive `sentry-trace` / `baggage`.
 *
 * Must be set. Unset means "propagate to everything" on Node — `shouldPropagateTraceForUrl`
 * in @sentry/core short-circuits to `true` when the option is falsy, and nothing
 * in @sentry/node supplies a default. The backend calls the Aurora APIs, the
 * Instagram oEmbed endpoint (`src/lib/instagram-meta.ts`), the TikTok oEmbed
 * endpoint (`src/lib/tiktok-meta.ts`) and Tigris object storage. None of them
 * should see our trace ids.
 */
export const BACKEND_TRACE_PROPAGATION_TARGETS: (string | RegExp)[] = [/^\//, 'www.boardsesh.com'];

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

/**
 * The parts of Sentry's `TracesSamplerSamplingContext` this module reads.
 *
 * Structural on purpose: no `@sentry/*` import, so a test needs no SDK and
 * `instrument.ts` adapts the real context at the call site.
 */
export type BackendSamplingRequest = {
  /** Span name. @sentry/node builds server spans as `"<METHOD> <path>"`. */
  readonly name?: string;
  /** Span attributes. `url.path` and `http.url` are set by httpServerSpansIntegration. */
  readonly attributes?: { readonly [attributeKey: string]: unknown };
  /** Normalized request, when the isolation scope carries one. */
  readonly normalizedRequest?: {
    readonly url?: string;
    readonly method?: string;
    readonly headers?: { readonly [headerName: string]: string };
  };
  /**
   * Sampling decision inherited from an incoming `sentry-trace` header.
   *
   * Present in the type so the rule below can say, in code, that it is ignored.
   */
  readonly parentSampled?: boolean;
};

/** Path being sampled, without origin or query string. `''` when undeterminable. */
export function resolveBackendRequestPath(request: BackendSamplingRequest): string {
  const attributePath = request.attributes?.['url.path'];
  if (typeof attributePath === 'string' && attributePath.length > 0) return attributePath;

  const attributeUrl = request.attributes?.['http.url'];
  const candidateUrl =
    (typeof attributeUrl === 'string' ? attributeUrl : undefined) ??
    request.normalizedRequest?.url ??
    stripLeadingMethod(request.name);
  if (!candidateUrl) return '';

  try {
    return new URL(candidateUrl, 'http://sampler.invalid').pathname;
  } catch {
    const queryStart = candidateUrl.indexOf('?');
    return queryStart === -1 ? candidateUrl : candidateUrl.slice(0, queryStart);
  }
}

/** Uppercased HTTP method for the request being sampled. `''` when undeterminable. */
export function resolveBackendRequestMethod(request: BackendSamplingRequest): string {
  const attributeMethod = request.attributes?.['http.request.method'] ?? request.attributes?.['http.method'];
  if (typeof attributeMethod === 'string' && attributeMethod.length > 0) return attributeMethod.toUpperCase();

  const normalizedMethod = request.normalizedRequest?.method;
  if (normalizedMethod) return normalizedMethod.toUpperCase();

  const firstToken = request.name?.split(' ')[0]?.toUpperCase();
  return firstToken && HTTP_METHODS.has(firstToken) ? firstToken : '';
}

/**
 * True for a WebSocket handshake.
 *
 * Party mode's graphql-ws server is mounted on `/graphql` (websocket/setup.ts),
 * so an upgrade and a GraphQL POST share a path and only the headers tell them
 * apart. A connection that lives for a whole climbing session has no meaningful
 * "duration" to record, and one span per connect would swamp the sample.
 */
export function isWebSocketUpgrade(request: BackendSamplingRequest): boolean {
  const headers = request.normalizedRequest?.headers;
  if (!headers) return false;

  if (headers.upgrade?.toLowerCase() === 'websocket') return true;
  return headers.connection?.toLowerCase().includes('upgrade') ?? false;
}

function stripLeadingMethod(name: string | undefined): string {
  if (!name) return '';

  const [firstToken, ...rest] = name.split(' ');
  return HTTP_METHODS.has(firstToken.toUpperCase()) ? rest.join(' ') : name;
}

/**
 * Sample rate for one backend transaction.
 *
 * **This function must return an explicit number and must never consult
 * `parentSampled` (nor call Sentry's `inheritOrSampleWith`).** It reads like a
 * bug — Sentry's own docs push `inheritOrSampleWith` as the default shape, and
 * a `tracesSampleRate` (rather than a sampler) inherits the parent decision
 * outright. But web SSR is a major source of `POST /graphql` volume here: the
 * Railway HTTP logs show `clientUa: "node"` hitting /graphql at high rate, and
 * web samples at 25%. Inheriting would record a quarter of SSR-driven GraphQL
 * requests instead of 1% of them, which is the difference between ~123,000 and
 * ~2,600,000 sampled requests a month — an order of magnitude past the budget
 * derived at the top of this file.
 *
 * Traces are still connected: an unsampled backend transaction keeps
 * propagating the trace id, it just doesn't record a segment of its own.
 */
export function resolveBackendTracesSampleRate(request: BackendSamplingRequest): number {
  if (isWebSocketUpgrade(request)) return 0;

  const path = resolveBackendRequestPath(request);

  if (ZERO_RATE_PATHS.has(path)) return 0;
  if (ZERO_RATE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return 0;

  if (path === GRAPHQL_PATH) return GRAPHQL_SAMPLE_RATE;
  if (path === OG_CLIMB_PATH) return OG_CLIMB_SAMPLE_RATE;

  return BACKEND_DEFAULT_SAMPLE_RATE;
}
