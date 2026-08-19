import { isDatabaseLockedError } from '../db/lock-errors';

type GraphqlErrorEntry = {
  extensions?: { code?: unknown; status?: unknown };
};

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

// Locale-independent markers that identify a transport/offline failure regardless
// of device language. These are stable IDENTIFIERS, not localized prose:
//   - the fetch/polyfill wrapper strings ("Network request failed", "Failed to
//     fetch", "fetch failed") are hardcoded English by the runtime, never localized
//     (RN whatwg-fetch, browser/undici, and the WinterCG "fetch failed: <cause>"
//     wrapper respectively);
//   - Java networking exception class names surface verbatim in Android messages
//     (e.g. `java.net.UnknownHostException`), independent of locale.
// Kept narrow (never bare "network"/"fetch") so a programmer bug like
// `TypeError: Cannot read property 'fetch' of undefined` is NOT swallowed.
const TRANSPORT_NETWORK_MARKERS =
  /network request failed|failed to fetch|fetch failed|unknownhostexception|sockettimeoutexception|socketexception|connectexception|sslexception|sslhandshakeexception|sslpeerunverifiedexception|unknownserviceexception/i;

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
 * A successful GraphQL HTTP response whose body was empty or truncated before
 * the client could read a server verdict. Match structurally so this package
 * remains independent of the platform-specific error class, and follow bounded
 * `.cause` chains because fetch wrappers may preserve the original error there.
 */
function isGraphQLEmptyResponseErrorAtDepth(error: unknown, depth: number): boolean {
  if (error === null || typeof error !== 'object') return false;

  const name = (error as { name?: unknown }).name;
  if (name === GRAPHQL_EMPTY_RESPONSE_ERROR_NAME) return true;

  if (depth < MAX_CAUSE_DEPTH) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error) {
      return isGraphQLEmptyResponseErrorAtDepth(cause, depth + 1);
    }
  }

  return false;
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

export function isRetryable(error: unknown): boolean {
  // Local SQLite write-lock contention is ALWAYS retryable. It is not a server
  // verdict at all: another connection (a snapshot import, a VACUUM, another
  // write) held the file for a moment, and a holder always lets go. It reaches
  // classification because the drainer's per-mutation try wraps the local
  // bookkeeping write as well as the send, so a lock thrown by `markCompleted`
  // resolved no status, fell through to `return false` below, and
  // force-dead-lettered a write the server had ALREADY accepted (#4331 — every
  // `Offline Mutation Dead Lettered` event in a 45-day window carried
  // `database is locked` and no server status). The drainer handles a lock
  // ahead of this call so it doesn't burn the persistent retry budget either;
  // this is the verdict the rest of the engine sees.
  if (isDatabaseLockedError(error)) {
    return true;
  }

  // Network failures always retry — the request never reached the server, so
  // replaying it is safe. `isNetworkError` itself now defers to a resolved status
  // for the English-prose-only case (#4027), so this check is already
  // status-aware even though it textually runs before the `getErrorStatus` call
  // below — see isNetworkError's doc comment for why the precedence lives there
  // rather than being duplicated here.
  if (isNetworkError(error)) {
    return true;
  }

  const status = getErrorStatus(error);

  // No resolvable HTTP/GraphQL status and not a recognized network error: most
  // likely a programmer / validation / parse bug. Dead-letter it (I5) so it's
  // surfaced to the user instead of silently burning the retry budget.
  if (status === null) {
    return false;
  }

  // 401 is retryable because the drainer's fetch is authenticatedFetch
  // (lib/auth-interceptor): it refreshes the token and retries once BEFORE the
  // error reaches classification, and a failed refresh forces sign-out — which
  // wipes the pending queue — so a retried 401 can't loop against a dead session.
  if (status === 401) return true;
  if (status === 429) return true;
  if (status >= 500) return true;

  return false;
}
