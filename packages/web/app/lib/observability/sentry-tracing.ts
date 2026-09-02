/**
 * Pure helpers behind the web app's Sentry tracing configuration.
 *
 * `sentry.server.config.ts` / `sentry.edge.config.ts` call `Sentry.init()` at
 * module load, so they can't be imported from a test. Everything here is a pure
 * function those files delegate to, which is what makes the sampling rules
 * testable without booting the SDK.
 */

/**
 * Sample rate for a server transaction that isn't explicitly zeroed below.
 *
 * Span budget (system target: <= 3M spans/month).
 *
 * `boardsesh-web` served 12,422 requests in the 7 days to 2026-09-01, so:
 *   12,422 / 7 * 30    = ~53,200 requests/month
 *   53,200 * 0.25      = ~13,300 sampled requests/month
 *   * ~4 spans each    = ~53,000 spans/month
 *
 * Web is under 2% of the budget even at 25%. `boardsesh-backend` is the one
 * that has to be rationed (3,371,614 requests over the same 7 days, 260x web) —
 * see the arithmetic in `packages/backend/src/lib/sentry-sampling.ts`. Keeping
 * web at 25% is what makes route-level p75 latency readable: at 1% the thin
 * tail of marketing and gym routes would never accumulate enough samples to
 * have a p75 at all, which is the whole reason this stage exists (we lost
 * Vercel Observability Plus when www moved to the Railway container).
 */
export const WEB_SERVER_TRACES_SAMPLE_RATE = 0.25;

/**
 * Hosts (and relative paths) that may receive `sentry-trace` / `baggage`.
 *
 * This option MUST be set on Node. When it is left unset, `shouldPropagateTraceForUrl`
 * in @sentry/core returns `true` for every URL:
 *
 *   if (typeof url !== 'string' || !tracePropagationTargets) { return true; }
 *
 * ...and nothing in @sentry/node fills in a default (`injectTracePropagationHeaders`
 * reads the option straight off the client). So an unset value ships our trace
 * ids to kilterboardapp.com, tensionboardapp2.com, Tigris/S3 and the Google /
 * Apple OAuth endpoints. `app/lib/api-wrappers/aurora/util.ts` already fights
 * the Aurora API over request headers; don't hand it two more.
 *
 * Note this is the opposite of the browser default, which is same-origin-only —
 * see the comment in `instrumentation-client.ts`.
 */
export const WEB_TRACE_PROPAGATION_TARGETS: (string | RegExp)[] = [/^\//, 'ws.boardsesh.com', 'www.boardsesh.com'];

/**
 * Next's Sentry tunnel (`tunnelRoute: '/monitoring'` in next.config.mjs). Every
 * browser envelope arrives here as a route handler POST.
 */
const SENTRY_TUNNEL_PATH = '/monitoring';

/** Railway's own health probe target. Constant traffic, zero diagnostic value. */
const HEALTH_PATH = '/api/health';

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

/**
 * The parts of a Sentry `TracesSamplerSamplingContext` the sampler reads.
 *
 * Declared structurally so this module has no `@sentry/*` import at all: the
 * config files adapt the SDK's context to this shape at the call site.
 */
export type TraceSamplingRequest = {
  /** Span name, which Sentry builds as `"<METHOD> <path>"` for server spans. */
  readonly name?: string;
  /** HTTP method, when the context carries one separately from the name. */
  readonly method?: string;
  /** Request URL or path. Absolute or relative; query string allowed. */
  readonly url?: string;
};

/**
 * Path of the request being sampled, without query string or origin.
 *
 * Prefers an explicit URL and falls back to the span name, which for a server
 * span is `"<METHOD> <path>"`. Returns `''` when neither yields a path — the
 * callers treat that as "unknown", which samples at the default rate rather
 * than silently dropping.
 */
export function resolveSampledRequestPath({ name, url }: TraceSamplingRequest): string {
  const candidatePath = url ?? stripLeadingMethod(name);
  if (!candidatePath) return '';

  // `new URL` with a base handles absolute and relative alike, and strips the
  // query and fragment for us. An unparseable value falls through to a manual
  // truncation rather than throwing inside the sampler.
  try {
    return new URL(candidatePath, 'http://sampler.invalid').pathname;
  } catch {
    const queryStart = candidatePath.indexOf('?');
    return queryStart === -1 ? candidatePath : candidatePath.slice(0, queryStart);
  }
}

/** Uppercased HTTP method, preferring an explicit one over the span name's prefix. */
export function resolveSampledRequestMethod({ name, method }: TraceSamplingRequest): string {
  if (method) return method.toUpperCase();

  const firstToken = name?.split(' ')[0]?.toUpperCase();
  return firstToken && HTTP_METHODS.has(firstToken) ? firstToken : '';
}

function stripLeadingMethod(name: string | undefined): string {
  if (!name) return '';

  const [firstToken, ...rest] = name.split(' ');
  return HTTP_METHODS.has(firstToken.toUpperCase()) ? rest.join(' ') : name;
}

/**
 * Sample rate for one web server (or edge) transaction.
 *
 * Two paths are zeroed:
 *
 *   POST /monitoring — the Sentry tunnel. This one is load-bearing, not
 *     hygiene. Every browser envelope the client SDK sends is proxied through
 *     this Next route handler, so with tracing on, each one would mint its own
 *     server transaction. That roughly doubles server span volume and, worse,
 *     buries the p75-by-route table under a route that is Sentry talking to
 *     itself. A trace of "we reported a trace" tells us nothing.
 *
 *   /api/health — Railway's health probe. Fires on a fixed interval forever,
 *     never varies, and would dominate the transaction count.
 */
export function resolveWebTracesSampleRate(request: TraceSamplingRequest): number {
  const path = resolveSampledRequestPath(request);
  const method = resolveSampledRequestMethod(request);

  if (path === SENTRY_TUNNEL_PATH && (method === 'POST' || method === '')) return 0;
  if (path === HEALTH_PATH || path.startsWith(`${HEALTH_PATH}/`)) return 0;

  return WEB_SERVER_TRACES_SAMPLE_RATE;
}

/**
 * Span attributes that carry a full request URL, and therefore a query string.
 *
 * `http.url` is the old semantic-convention key, `url.full` the current one;
 * @sentry/node's http instrumentation still sets both.
 */
export const SENSITIVE_URL_SPAN_ATTRIBUTE_KEYS = ['http.url', 'url.full'] as const;

/** Minimal shape of a Sentry `SpanJSON` for redaction purposes. */
export type RedactableSpan = {
  readonly data: { [attributeKey: string]: unknown };
};

/**
 * Drop the query string from a URL that shouldn't have one recorded.
 *
 * `sendDefaultPii: true` is on and stays on — it is what puts a user on an
 * error, and triage depends on it. But turning tracing on widens its blast
 * radius from "errors carry a user" to "every sampled request records its URL",
 * so the two query strings that actually matter get stripped here:
 *
 *   /api/auth/**  — NextAuth's `code` and `state`. An OAuth authorization code
 *                   is a single-use credential; it has no business sitting in a
 *                   span attribute that a Sentry seat can read.
 *   ?session=...  — a session identifier in any path.
 */
export function stripSensitiveQueryString(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return rawUrl;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, 'http://sampler.invalid');
  } catch {
    return rawUrl;
  }

  const isAuthCallback = parsedUrl.pathname === '/api/auth' || parsedUrl.pathname.startsWith('/api/auth/');
  if (isAuthCallback || parsedUrl.searchParams.has('session')) {
    return rawUrl.slice(0, queryStart);
  }

  return rawUrl;
}

/**
 * `beforeSendSpan` body: rewrite URL attributes in place and hand the span back.
 *
 * Mutates rather than clones because Sentry passes ownership of the span
 * payload to this callback, and cloning a `SpanJSON` would lose nothing but
 * cost an allocation on every span of every sampled request.
 */
export function redactSensitiveSpanUrls<TSpan extends RedactableSpan>(span: TSpan): TSpan {
  for (const attributeKey of SENSITIVE_URL_SPAN_ATTRIBUTE_KEYS) {
    const rawUrl = span.data[attributeKey];
    if (typeof rawUrl !== 'string') continue;

    const strippedUrl = stripSensitiveQueryString(rawUrl);
    if (strippedUrl !== rawUrl) {
      span.data[attributeKey] = strippedUrl;
    }
  }

  return span;
}

/** Header Railway's edge stamps on every request it forwards into the container. */
export const RAILWAY_REQUEST_ID_HEADER = 'x-railway-request-id';

/** Sentry tag the header is promoted to. */
export const RAILWAY_REQUEST_ID_TAG = 'railway_request_id';

/** Minimal shape of a Sentry `Event` for the request-id processor. */
export type RailwayTaggableEvent = {
  readonly request?: { readonly headers?: { readonly [headerName: string]: string } };
  tags?: { [tagName: string]: unknown };
};

/**
 * Promote Railway's request id onto the event as a tag.
 *
 * This is the join key between a Railway HTTP log line and a Sentry event: the
 * edge stamps `x-railway-request-id` on the request to the container and logs
 * the same value, so with the tag in place a slow or failing request found in
 * one system can be looked up in the other. Nothing has to be plumbed through
 * the app — `sendDefaultPii: true` already puts request headers on the
 * isolation scope, so the header is sitting on the event by the time a
 * processor runs.
 *
 * Absent header is the normal case off Railway (local dev, tests): return the
 * event untouched rather than writing an empty tag.
 */
export function tagRailwayRequestId<TEvent extends RailwayTaggableEvent>(event: TEvent): TEvent {
  const requestId = event.request?.headers?.[RAILWAY_REQUEST_ID_HEADER];
  if (typeof requestId !== 'string' || requestId.length === 0) return event;

  event.tags = { ...event.tags, [RAILWAY_REQUEST_ID_TAG]: requestId };
  return event;
}
