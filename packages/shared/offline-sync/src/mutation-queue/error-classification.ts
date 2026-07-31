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

/**
 * Pure, locale-independent predicate: is this a transport/reachability failure
 * (offline, DNS, reset, TLS, timeout) that never reached the server? Matches on
 * error name/code and stable message markers rather than localized prose, and
 * recurses into `.cause` because WinterCG/undici wrap the underlying error there.
 *
 * Shared by the offline drainer's dead-letter classifier (`isNetworkError` below)
 * and mobile's `reportHandledError` noise policy (imported via the
 * `@boardsesh/offline-sync/error-classification` subpath) so both agree on what
 * "offline" means. Deliberately excludes AbortError — its cancel-vs-retry meaning
 * differs per call site, so each site handles it.
 */
export function isTransportNetworkError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object') return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSPORT_NETWORK_CODES.has(code)) return true;

  const message = (error as { message?: unknown }).message;
  if (
    typeof message === 'string' &&
    (TRANSPORT_NETWORK_MARKERS.test(message) || IOS_NSURL_ENGLISH_DESCRIPTIONS.test(message))
  ) {
    return true;
  }

  if (depth < MAX_CAUSE_DEPTH) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error && isTransportNetworkError(cause, depth + 1)) return true;
  }

  return false;
}

/**
 * A network-reachability failure: the request never reached the server (offline,
 * DNS, connection reset, TLS, timeout). Surfaced as a TypeError (RN whatwg-fetch),
 * a plain Error carrying the WinterCG "fetch failed: <cause>" wrapper, or a bare
 * NSURLError description. Distinct from a server that replied with an error status
 * — the drainer treats these two very differently (a network error must never
 * advance retry_count toward the dead-letter).
 */
export function isNetworkError(error: unknown): boolean {
  if (isTransportNetworkError(error)) return true;
  // A cancelled request (app backgrounded mid-drain, AbortController timeout)
  // surfaces as an error NAMED AbortError — not a TypeError, and not reliably a
  // DOMException instance across RN runtimes, so match by name. The request
  // never completed against the server, so replaying is safe; without this
  // branch an aborted write would resolve no status and dead-letter.
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return false;
}

export function isRetryable(error: unknown): boolean {
  // Network failures always retry — the request never reached the server, so
  // replaying it is safe.
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
