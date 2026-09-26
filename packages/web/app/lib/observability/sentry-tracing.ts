/**
 * Pure helpers behind the web app's Sentry tracing configuration.
 *
 * `sentry.server.config.ts` / `sentry.edge.config.ts` call `Sentry.init()` at
 * module load, so they can't be imported from a test. Everything here is a pure
 * function those files delegate to, which is what makes the sampling rules
 * testable without booting the SDK.
 */

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@boardsesh/i18n';

/**
 * Sample rate for a server transaction that isn't explicitly zeroed or
 * rationed below.
 *
 * Span budget. The org quota is 5M stored spans/month; the target set when
 * tracing went on (cdcb32cca8) is <= 3M/month across web and backend.
 *
 * The original derivation here counted 12,422 web requests over 7 days and
 * ~4 spans per sampled request, which came out at ~53,000 spans/month. Both
 * inputs were wrong. Measured over 14 days in 2026-09 (Sentry `count_sample()`
 * on stored spans), web alone stored several million spans:
 *
 *   climb view route              2.89M  (52% of all stored spans, org-wide)
 *   Next.js internal spans        1.96M  (generateMetadata, render route, ...)
 *   http.client                   0.64M  (incl. ~52k/7d forwarding /monitoring)
 *   graphql.parse                 ~246k/7d (graphql-request's document parse)
 *
 * A sampled App Router render is dozens of spans, not four, and the climb view
 * (`/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]`)
 * is crawled at a rate the request count above never saw. So:
 *
 *   - the climb view is rationed to CLIMB_VIEW_TRACES_SAMPLE_RATE (5%, a 5x cut:
 *     ~2.9M/14d is ~6.2M/month at 25%, ~1.2M/month at 5%, and the internals
 *     dropped below take a large share of what remains);
 *   - the Next.js internals, the tunnel forward and graphql.parse/validate are
 *     dropped span-by-span via WEB_IGNORED_SPANS, without losing the root.
 *
 * Every other route stays at 25%. That is what makes route-level p75 latency
 * readable: at 1% the thin tail of marketing and gym routes would never
 * accumulate enough samples to have a p75 at all, which is the whole reason
 * server tracing exists (we lost Vercel Observability Plus when www moved to
 * the Railway container). The backend's arithmetic is in
 * `packages/backend/src/lib/sentry-sampling.ts`.
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

/**
 * Rate for the climb view. It stored 2.89M spans in 14 days at 25% — half of
 * everything the org stored — so it is rationed to a fifth of the default. At
 * this volume 5% still leaves thousands of samples a day for its p75.
 */
export const CLIMB_VIEW_TRACES_SAMPLE_RATE = 0.05;

/**
 * `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]`,
 * optionally behind a locale prefix. The prefixes are derived from
 * SUPPORTED_LOCALES so a new locale cannot slip its climb pages past the ration.
 *
 * Matched against the raw request path, because that is what the sampler sees
 * (`GET /moonboard/2016/standard-11x18-grid/.../40/view/skyline-7804be6e-...`),
 * not the parameterised route name. `view` must be exactly the sixth segment,
 * so `/play/...` and other seven-segment paths keep the default rate.
 */
const LOCALE_PATH_PREFIXES = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).join('|');
const CLIMB_VIEW_PATH = new RegExp(`^(?:/(?:${LOCALE_PATH_PREFIXES}))?/[^/]+/[^/]+/[^/]+/[^/]+/[^/]+/view/[^/]+/?$`);

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

  if (CLIMB_VIEW_PATH.test(path)) return CLIMB_VIEW_TRACES_SAMPLE_RATE;

  return WEB_SERVER_TRACES_SAMPLE_RATE;
}

/**
 * One entry of Sentry's `ignoreSpans` option, declared structurally so this
 * module keeps no `@sentry/*` import. The object form is the op-scoped arm of
 * `IgnoreSpanFilter` in @sentry/core (`op` required, `name` optional): every
 * field given must match for the span to be dropped.
 */
export type WebIgnoredSpanPattern =
  | string
  | RegExp
  | {
      readonly name?: string | RegExp;
      readonly op: string | RegExp;
    };

/**
 * Spans the web server and edge SDKs drop before sending.
 *
 * Matching semantics (@sentry/core `shouldIgnoreSpan` / `isMatchingPattern`):
 * a bare string or RegExp is tested against the span NAME; a string matches as
 * a SUBSTRING, not exactly. So every entry here is an anchored RegExp, which
 * keeps a future span that merely contains one of these words alive. A
 * dropped child's own children are re-parented to its parent. A matching ROOT
 * drops its whole transaction, which is intended for a root `graphql.parse`.
 *
 * Why not `beforeSendSpan`: in SDK v10 returning null from it only logs a
 * warning and keeps the span. And why not `{ op: 'default' }`: Sentry shows
 * Next's spans as `default` but their op is actually undefined, so they have
 * to be matched by name.
 *
 * `http.client` spans to the backend (`POST http://boardsesh-backend...`) are
 * deliberately kept: they are the outbound-API-by-hostname view.
 */
export const WEB_IGNORED_SPANS: WebIgnoredSpanPattern[] = [
  // Next.js App Router internals: ~1.96M stored spans in 14 days. The root
  // http.server span already carries the route's total latency.
  /^generateMetadata /,
  /^resolve page components$/,
  /^start response$/,
  /^build component tree$/,
  /^render route \(app\)/,
  /^NextNodeServer\.clientComponentLoading$/,
  // The /monitoring tunnel forwarding a browser envelope to Sentry: Sentry
  // tracing itself talking to Sentry (~52k/7d).
  { op: 'http.client', name: /\/api\/\d+\/envelope\/$/ },
  // graphql-request parsing its own documents (~246k/7d). The Graphql
  // integration is also disabled in sentry.server.config.ts; this catches any
  // path that still produces them.
  /^graphql\.parse$/,
  /^graphql\.validate$/,
];

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
