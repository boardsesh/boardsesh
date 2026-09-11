type GraphqlErrorEntry = {
  extensions?: { code?: unknown; status?: unknown };
};

/**
 * Does any entry in a GraphQL `errors` array carry this STRING `extensions.code`?
 * Deliberately string-only: a NUMERIC `extensions.code` is an HTTP status in
 * disguise and belongs to `statusFromGraphqlErrors` below, so the two readers
 * never claim the same field.
 */
function graphqlErrorsCarryCode(errors: unknown, code: string): boolean {
  if (!Array.isArray(errors)) return false;
  for (const entry of errors as GraphqlErrorEntry[]) {
    const entryCode = entry?.extensions?.code;
    if (typeof entryCode === 'string' && entryCode === code) return true;
  }
  return false;
}

function statusFromGraphqlErrors(errors: unknown): number | null {
  if (!Array.isArray(errors)) return null;
  for (const entry of errors as GraphqlErrorEntry[]) {
    const extensions = entry?.extensions;
    if (extensions && typeof extensions.code === 'number') {
      return extensions.code;
    }
    if (extensions && typeof extensions.status === 'number') {
      return extensions.status;
    }
  }
  return null;
}

export function getErrorStatus(error: unknown): number | null {
  if (error instanceof Response) {
    return error.status;
  }

  if (error && typeof error === 'object') {
    if ('status' in error && typeof (error as Record<string, unknown>).status === 'number') {
      return (error as Record<string, unknown>).status as number;
    }

    if ('response' in error) {
      const response = (error as Record<string, unknown>).response;
      if (response && typeof response === 'object') {
        // HTTP status surfaced under .response.status
        if ('status' in response && typeof (response as Record<string, unknown>).status === 'number') {
          return (response as Record<string, unknown>).status as number;
        }
        // graphql-request's ClientError nests GraphQL errors under .response.errors
        const nestedStatus = statusFromGraphqlErrors((response as Record<string, unknown>).errors);
        if (nestedStatus !== null) {
          return nestedStatus;
        }
      }
    }

    if ('errors' in error) {
      const topLevelStatus = statusFromGraphqlErrors((error as Record<string, unknown>).errors);
      if (topLevelStatus !== null) {
        return topLevelStatus;
      }
    }
  }

  return null;
}

/**
 * Does this error carry the spec-shaped STRING GraphQL error code `code`?
 * Reads exactly the shapes `getErrorStatus` walks — a top-level `errors` array
 * and graphql-request's `error.response.errors` — plus an `extensions` object on
 * the error itself, which is how a single GraphQLError arrives when it is
 * re-thrown rather than collected into a response envelope.
 *
 * Numeric `extensions.code` values are ignored on purpose (see
 * `graphqlErrorsCarryCode`): those are statuses, and asking for them here would
 * make `hasGraphqlErrorCode(error, '500')` accidentally meaningful.
 */
export function hasGraphqlErrorCode(error: unknown, code: string, depth = 0): boolean {
  if (error === null || typeof error !== 'object') return false;

  const errorRecord = error as Record<string, unknown>;

  // Same bounded `.cause` walk the stable-name checks use: a future fetch
  // wrapper that re-throws the graphql-request ClientError as a cause must not
  // silently reopen the instant dead-letter this predicate exists to prevent.
  if (depth < MAX_CAUSE_DEPTH) {
    const cause = errorRecord.cause;
    if (cause !== undefined && cause !== error && hasGraphqlErrorCode(cause, code, depth + 1)) return true;
  }

  if (graphqlErrorsCarryCode(errorRecord.errors, code)) return true;

  const response = errorRecord.response;
  if (response !== null && typeof response === 'object') {
    if (graphqlErrorsCarryCode((response as Record<string, unknown>).errors, code)) return true;
  }

  const extensions = errorRecord.extensions;
  if (extensions !== null && typeof extensions === 'object') {
    const extensionCode = (extensions as { code?: unknown }).code;
    if (typeof extensionCode === 'string' && extensionCode === code) return true;
  }

  return false;
}

// Locale-independent markers that identify a transport/offline failure regardless
// of device language. These are stable IDENTIFIERS, not localized prose:
//   - the fetch/polyfill wrapper strings ("Network request failed", "Network
//     request timed out", "Failed to fetch", "fetch failed") are hardcoded
//     English by the runtime, never localized (RN whatwg-fetch, browser/undici,
//     and the WinterCG "fetch failed: <cause>" wrapper respectively). The first
//     two are siblings from the same whatwg-fetch XHR pair: `xhr.onerror`
//     rejects with "Network request failed" (fetch.umd.js:567) and
//     `xhr.ontimeout` with "Network request timed out" (:573). Only the first
//     was listed here, so a timed-out send resolved no status, matched nothing,
//     and was dead-lettered on attempt 0 of 10 (#5295);
//   - Java networking exception class names surface verbatim in Android messages
//     (e.g. `java.net.UnknownHostException`), independent of locale.
// Kept narrow (never bare "network"/"fetch"/"timed out") so a programmer bug like
// `TypeError: Cannot read property 'fetch' of undefined` is NOT swallowed. The
// timeout marker is the FULL phrase for the same reason: `BLE write timed out
// waiting for the board to accept data` is a board failure, not a network one
// (#3869).
const TRANSPORT_NETWORK_MARKERS =
  /network request failed|network request timed out|failed to fetch|fetch failed|unknownhostexception|sockettimeoutexception|socketexception|connectexception|sslexception|sslhandshakeexception|sslpeerunverifiedexception|unknownserviceexception/i;

// errno-style transport codes carried on the error or its `.cause` (undici / Node
// networking). Locale-independent.
const TRANSPORT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EPIPE',
]);

// Best-effort, ENGLISH-ONLY, tried LAST: iOS URLSession (NSURLError)
// localizedDescriptions that arrive WITHOUT the always-English "fetch failed:"
// wrapper (e.g. a bare WebSocket transport error). Non-English locales won't match
// here by design — the locale-independent marker/code/cause checks above are the
// primary signal; this only rescues the un-wrapped English case. Phrases stay
// specific (never a bare "connection"/"network"/"timed out") so a real bug is
// never misclassified as offline.
const IOS_NSURL_ENGLISH_DESCRIPTIONS =
  /the request timed out|network connection was lost|connection appears to be offline|could not connect to the server|secure connection to the server cannot be made|secure connection failed|the connection has timed out|not connected to the internet/i;

const MAX_CAUSE_DEPTH = 3;

/** Stable cross-client identifier for a truncated successful GraphQL response. */
export const GRAPHQL_EMPTY_RESPONSE_ERROR_NAME = 'GraphQLEmptyResponseError';

/**
 * Stable cross-client identifier for the error the mobile app throws INSTEAD OF
 * sending a request, when its connectivity store says the backend is
 * unreachable, the device has no connection, or offline mode is switched on.
 * Nothing left the device, so no server verdict exists and a queued write must
 * never advance toward the dead-letter because of one (#4862).
 */
export const BACKEND_UNAVAILABLE_ERROR_NAME = 'BackendUnavailableError';

/**
 * The GraphQL `extensions.code` the mobile client attaches to the `AbortError`
 * it raises when a request outlives its own deadline. Like any abort, the
 * request never completed against the server, so replaying it is safe.
 */
export const GRAPHQL_REQUEST_TIMEOUT_CODE = 'GRAPHQL_REQUEST_TIMEOUT';

/**
 * Does `error` — or, along a bounded `.cause` chain, anything it wraps — carry
 * this stable error name? Matching the NAME rather than the class keeps this
 * package independent of the platform-specific error classes that throw these,
 * and the `.cause` walk catches the case where a fetch wrapper kept the original
 * error underneath.
 */
function hasStableErrorName(error: unknown, name: string, depth: number): boolean {
  if (error === null || typeof error !== 'object') return false;

  if ((error as { name?: unknown }).name === name) return true;

  if (depth < MAX_CAUSE_DEPTH) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error) {
      return hasStableErrorName(cause, name, depth + 1);
    }
  }

  return false;
}

/**
 * A successful GraphQL HTTP response whose body was empty or truncated before
 * the client could read a server verdict. Match structurally so this package
 * remains independent of the platform-specific error class, and follow bounded
 * `.cause` chains because fetch wrappers may preserve the original error there.
 */
function isGraphQLEmptyResponseErrorAtDepth(error: unknown, depth: number): boolean {
  return hasStableErrorName(error, GRAPHQL_EMPTY_RESPONSE_ERROR_NAME, depth);
}

export function isGraphQLEmptyResponseError(error: unknown): boolean {
  return isGraphQLEmptyResponseErrorAtDepth(error, 0);
}

/**
 * Locale-independent half of the transport check: errno-style codes and the
 * always-English fetch/polyfill wrapper strings / Java exception class names
 * (never localized prose — see TRANSPORT_NETWORK_MARKERS above). Recurses into
 * `.cause` because WinterCG/undici wrap the underlying error there. Split out
 * from the English-prose heuristic below (rather than merged into one boolean)
 * so `isNetworkError` can give this signal unconditional precedence over a
 * resolved HTTP/GraphQL status while the prose fallback defers to one (#4027).
 */
function isLocaleIndependentTransportSignal(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object') return false;

  // The mobile GraphQL guard throws this stable named error after receiving
  // response headers but no usable 2xx body. The server verdict never arrived,
  // so queued writes must not advance toward the dead-letter. Match structurally
  // to keep this renderer-agnostic package independent of mobile.
  if (isGraphQLEmptyResponseErrorAtDepth(error, depth)) return true;

  // The mobile app raises this stable named error synthetically, before a
  // request is ever put on the wire, when its connectivity store reports the
  // backend unreachable / the device offline / offline mode on. That is a
  // reachability verdict by construction, so it belongs with the errno codes and
  // fetch-wrapper markers above: the drainer takes its `networkStop` branch and
  // retry_count stays untouched (#4862). Matched by name, like the empty-response
  // case, so this package stays independent of the mobile error class.
  if (hasStableErrorName(error, BACKEND_UNAVAILABLE_ERROR_NAME, depth)) return true;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSPORT_NETWORK_CODES.has(code)) return true;

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && TRANSPORT_NETWORK_MARKERS.test(message)) return true;

  if (depth < MAX_CAUSE_DEPTH) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error && isLocaleIndependentTransportSignal(cause, depth + 1)) return true;
  }

  return false;
}

/**
 * English-prose half of the transport check: the best-effort, un-wrapped iOS
 * NSURLError descriptions (see IOS_NSURL_ENGLISH_DESCRIPTIONS above). Recurses
 * into `.cause` the same way the locale-independent half does. Kept separate so
 * callers can require a resolved status to be absent before trusting it.
 */
function isEnglishProseTransportSignal(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object') return false;

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && IOS_NSURL_ENGLISH_DESCRIPTIONS.test(message)) return true;

  if (depth < MAX_CAUSE_DEPTH) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error && isEnglishProseTransportSignal(cause, depth + 1)) return true;
  }

  return false;
}

/**
 * Raw transport/reachability predicate covering both stable identifiers and the
 * best-effort English NSURL prose fallback. It recurses into `.cause` because
 * WinterCG/undici wrap the underlying error there.
 *
 * This preserves the raw union for callers that already know no server response
 * exists. Status-sensitive callers must use `isNetworkError` below so a resolved
 * HTTP/GraphQL status can take precedence over English prose without weakening
 * stable transport signals. It deliberately excludes AbortError, whose
 * cancel-vs-retry meaning differs by call site.
 */
export function isTransportNetworkError(error: unknown, depth = 0): boolean {
  return isLocaleIndependentTransportSignal(error, depth) || isEnglishProseTransportSignal(error, depth);
}

/**
 * A network-reachability failure: the request never reached the server (offline,
 * DNS, connection reset, TLS, timeout). Surfaced as a TypeError (RN whatwg-fetch),
 * a plain Error carrying the WinterCG "fetch failed: <cause>" wrapper, or a bare
 * NSURLError description. Distinct from a server that replied with an error status
 * — the drainer treats these two very differently (a network error must never
 * advance retry_count toward the dead-letter; instead it halts the whole drain
 * cycle to wait for reconnectivity — see drainer.ts's `networkStop`).
 *
 * The drainer calls this directly (drainer.ts) AND `isRetryable` below calls it
 * first — so the precedence decided here applies to both call sites. Locale-
 * independent signals (errno codes, stable markers, `.cause` chain) and a
 * cancelled request always count as network regardless of any status that also
 * resolves — those are trustworthy identifiers of a transport failure. The
 * English-prose NSURL fallback is a best-effort LAST RESORT for un-wrapped iOS
 * descriptions: when a real HTTP/GraphQL status ALSO resolves, the server verdict
 * wins. Without this, a 400 (or any status) whose message happens to match the
 * English prose would head-of-line-block the ENTIRE drain cycle waiting for a
 * reconnect that, since the request demonstrably reached the server, will never
 * come (#4027).
 */
export function isNetworkError(error: unknown): boolean {
  if (isLocaleIndependentTransportSignal(error)) return true;
  // A cancelled request (app backgrounded mid-drain, AbortController timeout)
  // surfaces as an error NAMED AbortError — not a TypeError, and not reliably a
  // DOMException instance across RN runtimes, so match by name. The request
  // never completed against the server, so replaying is safe; without this
  // branch an aborted write would resolve no status and dead-letter.
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  // A resolved HTTP/GraphQL status is a server verdict: the request reached the
  // server, so this is not a transport/reachability failure no matter what the
  // message says. Only fall through to the English-prose heuristic when no
  // status resolves at all.
  if (getErrorStatus(error) !== null) {
    return false;
  }
  return isEnglishProseTransportSignal(error);
}

/**
 * The masked GraphQL code the backend serves when an unexpected server-side
 * failure (a Postgres outage, a driver throw) is scrubbed before it reaches a
 * client — see packages/backend/src/graphql/mask-error.ts. It rides a GraphQL
 * error over HTTP 200, so it is invisible to any status-only check.
 */
const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * A 404 / 502 / 503 / 504: an edge/proxy verdict, not a verdict on this request
 * — a gateway, a router, or a backend that is not accepting work right now. The
 * drainer treats all four like a dropped connection: end the cycle, charge the
 * mutation nothing.
 *
 * 404 belongs here rather than with the permanent rejections because of what
 * this client is. The drainer speaks GraphQL-over-POST to ONE endpoint, and a
 * GraphQL server answers "no such thing" as HTTP 200 with an `errors` array —
 * it has no way to say not-found in the status line. So a 404 arriving here can
 * only mean something in front of the server failed to route the request, and
 * the write is as replayable as if the connection had dropped. Railway's edge
 * served exactly that for 6m30s on 2026-09-02 and three climbers lost a logged
 * send (#5295).
 *
 * The decision is on STATUS only. That outage also set an `x-railway-fallback`
 * response header, which would identify the case precisely — and is exactly the
 * kind of single-host detail this code must not learn (docs/railway.md: nothing
 * Railway-specific in code, `pg_dump` and a `docker run` must be enough to move
 * hosts). The header is recorded in the test comment as evidence instead.
 */
export function isServerUnavailableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 404 || status === 502 || status === 503 || status === 504;
}

/**
 * "The server failed", however it was dressed: a real 5xx, or the masked
 * INTERNAL_SERVER_ERROR shape above arriving over HTTP 200. Ambiguous on its
 * own — one broken resolver and a whole unusable server look identical from
 * here — so the drainer uses it to decide whether a health probe is worth
 * running before it charges the mutation a retry.
 */
export function isServerFailureSignal(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== null && status >= 500) return true;
  return hasGraphqlErrorCode(error, INTERNAL_SERVER_ERROR_CODE);
}

/**
 * The HTTP statuses that are a server's PERMANENT verdict on this exact request:
 * replaying the identical bytes cannot change the answer. A malformed body
 * (400), a forbidden action (403), the wrong method (405), a conflict the
 * payload itself causes (409), a resource that is gone (410), a body too large
 * (413), an unsupported media type (415), and a semantically invalid payload
 * (422).
 *
 * 404 is deliberately NOT here — see `isServerUnavailableError` for why a 404
 * reaching a single-endpoint GraphQL client is a routing failure rather than a
 * rejection. 401 and 429 are absent for the reasons given in `isRetryable`.
 */
export const PERMANENT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 403, 405, 409, 410, 413, 415, 422]);

/**
 * The STRING GraphQL `extensions.code` values that carry the same meaning as
 * the statuses above: the server read this mutation and rejected it, and a
 * replay of the same bytes cannot change that answer.
 *
 * They need their own list because GraphQL has no way to put a verdict in the
 * status line — it answers "your input is invalid" with HTTP 200 and an
 * `errors` array. A status-only rule reads 200, finds no permanent status, and
 * retries a write the server will never accept: ten attempts, and because the
 * outbox is FIFO with a break on the first retryable hit, every write queued
 * behind it waits out those attempts too. Reading the code is the SAME rule as
 * PERMANENT_REJECTION_STATUSES applied at the layer GraphQL actually answers
 * on — not an exception to default-retry.
 *
 * Kept short on purpose. Anything NOT listed here stays retryable, and
 * `RATE_LIMITED` is the one to keep looking at on the way past: it is a
 * "later", not a "never", and turning it permanent is exactly the bug #4711
 * reports. INTERNAL_SERVER_ERROR is absent too — it is a scrubbed server
 * failure, decided as retryable before this check runs (#4862).
 */
export const PERMANENT_GRAPHQL_ERROR_CODES: ReadonlySet<string> = new Set([
  'BAD_USER_INPUT',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_REQUEST',
  'FORBIDDEN',
]);

/**
 * Did a server positively reject THIS request in a way a replay cannot fix?
 * This is now the only thing that stops a queued write from being retried, so
 * an error shape nobody has seen yet costs `max_retries` attempts instead of
 * costing the climber the write (#5295).
 *
 * Two readings of the same question: the HTTP status line, and — because
 * GraphQL answers on HTTP 200 — the `extensions.code` a resolver attached.
 */
export function isPermanentRejection(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== null && PERMANENT_REJECTION_STATUSES.has(status)) return true;

  // Only read a GraphQL verdict when the transport did not report one of its
  // own. A 404 / 502 / 503 / 504 is an edge or proxy talking about routing (see
  // isServerUnavailableError), and its body is an error page, not a resolver's
  // answer — so whatever that body happens to contain, the write never reached
  // a resolver and must stay replayable. `null` counts as "no transport
  // verdict": that is a bare GraphQLError re-thrown without a response envelope.
  const carriesAServerAnswer = status === null || (status >= 200 && status < 300);
  if (!carriesAServerAnswer) return false;

  for (const code of PERMANENT_GRAPHQL_ERROR_CODES) {
    if (hasGraphqlErrorCode(error, code)) return true;
  }
  return false;
}

export function isRetryable(error: unknown): boolean {
  // Network failures always retry — the request never reached the server, so
  // replaying it is safe. `isNetworkError` itself now defers to a resolved status
  // for the English-prose-only case (#4027), so this check is already
  // status-aware even though it textually runs before the `getErrorStatus` call
  // below — see isNetworkError's doc comment for why the precedence lives there
  // rather than being duplicated here.
  if (isNetworkError(error)) {
    return true;
  }

  // The backend masks an unexpected server-side failure — a Postgres outage, a
  // driver throw — as a GraphQLError carrying the STRING extensions.code
  // 'INTERNAL_SERVER_ERROR', served over HTTP 200 (mask-error.ts). Every
  // status-based rule below misreads that: graphql-request wraps it in a
  // ClientError whose response.status is 200, so the status resolves to 200,
  // sails past the null check and the 5xx check, and falls out of the bottom as
  // non-retryable — dead-lettering a tick queued during a DB outage on its
  // FIRST attempt (#4862). It sits between the network branch and the status
  // rules on purpose: the request DID reach a server, so it is not a network
  // error, but the status it carries means nothing. A genuine resolver bug
  // still ends up dead-lettered — it just spends max_retries getting there
  // instead of being lost on attempt one.
  if (hasGraphqlErrorCode(error, INTERNAL_SERVER_ERROR_CODE)) {
    return true;
  }

  // Everything else RETRIES: only a positively identified permanent server
  // verdict — a rejection status, or the GraphQL code a resolver attached to an
  // HTTP 200 — blocks a replay. The old default was the opposite — "no resolvable
  // status and not a recognized network error, so this is a programmer bug,
  // dead-letter it" — and it was wrong four times running, each time losing a
  // climber's logged send on attempt 0 of 10: a truncated 2xx body (#4099),
  // bare NSURL prose (#4027), a string `RATE_LIMITED` code (#4711), and
  // `TypeError: Network request timed out` (#5295). Each fix taught the
  // classifier one more shape and left the default in place for the fifth.
  //
  // The cost of being wrong in this direction is bounded and already paid for
  // elsewhere: `recordFailure` (queue.ts) flips the row to `dead_letter` in the
  // same atomic UPDATE that bumps past `max_retries` (10), so a genuine
  // programmer bug still surfaces to the user — as `retries_exhausted` after
  // ten attempts rather than `non_retryable` after one. That is the same trade
  // the INTERNAL_SERVER_ERROR branch above already makes.
  //
  // 401 and 429 stay out of PERMANENT_REJECTION_STATUSES on purpose. 401
  // because the drainer's fetch is authenticatedFetch (lib/auth-interceptor):
  // it refreshes the token and retries once BEFORE the error reaches
  // classification, and a failed refresh forces sign-out — which wipes the
  // pending queue — so a retried 401 can't loop against a dead session. 429 is
  // a "later", not a "never", and the drainer's backoff is the wait.
  return !isPermanentRejection(error);
}
