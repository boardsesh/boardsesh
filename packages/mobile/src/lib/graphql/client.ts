import { GraphQLClient } from 'graphql-request';
import { GRAPHQL_EMPTY_RESPONSE_ERROR_NAME } from '@boardsesh/offline-sync/error-classification';
import { authenticatedFetch } from '../auth-interceptor';
import { BackendUnavailableError } from '../connectivity/backend-unavailable-error';
import { getConnectivitySnapshot, reportBackendOutcome } from '../connectivity/connectivity-store';
import { BACKEND_URL } from '../env';
import { createAbortError, createGraphqlTimeoutError, isInteractiveRequestDeadlineEnabled } from './request-timeout';

// Re-exported so the predicate stays part of this module's public surface even
// though it lives in a leaf module the query provider can import on its own.
export { isGraphqlRequestTimeoutError } from './request-timeout';

export function getGraphQLHttpUrl(): string {
  return `${BACKEND_URL}/graphql`;
}

/**
 * A 2xx GraphQL response whose body is empty or not a JSON object/array — the
 * signature of a connection dropped mid-response (headers/status already
 * committed, body truncated) rather than a real GraphQL answer. Common on
 * flaky mobile networks going offline mid-request (#3190).
 *
 * `name` is checked by the shared offline-sync classifier so this gets the
 * same network-stop treatment in the mutation drainer and the same
 * "warning, tagged network" Sentry treatment as other transport failures.
 */
export class GraphQLEmptyResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GraphQL response body was empty or not valid JSON (HTTP ${status})`);
    this.name = GRAPHQL_EMPTY_RESPONSE_ERROR_NAME;
    this.status = status;
  }
}

/**
 * How long an INTERACTIVE request may hang before it is abandoned. Until #4862
 * there was no deadline here at all — only offline sync had one — so a request
 * to a wedged backend never settled and the screen behind it never left its
 * spinner. 20s is deliberately shorter than the sync deadline below: nobody is
 * watching a background pull, and somebody is always watching this.
 */
export const INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Offline pulls are retried by the sync scheduler, but it can only do that
 * after the current request settles. A fetch that never resolves would
 * otherwise hold the scheduler's single-flight lock forever and leave every
 * newly enabled board waiting behind it.
 */
export const OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS = 30_000;

/** The parsed 2xx body, or `undefined` when it is empty / not an object or array. */
function parseResponseBody(bodyText: string): unknown {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A 200 whose GraphQL errors say the SERVER broke, not that it disliked the
 * request. Yoga answers an unhandled resolver throw with `200 { errors: [{
 * extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }`, so status alone would
 * read that outage as a healthy response and the connectivity store would never
 * learn the backend is in trouble.
 *
 * Read off the already-parsed body rather than through the shared error
 * classifier: at this point we hold a decoded body, not an error, and the
 * classifier's status walkers only recognise NUMERIC codes.
 */
function hasInternalServerErrorCode(parsedBody: unknown): boolean {
  const documents = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  for (const document of documents) {
    if (typeof document !== 'object' || document === null) continue;
    const errors = (document as { errors?: unknown }).errors;
    if (!Array.isArray(errors)) continue;
    for (const graphqlError of errors) {
      if (typeof graphqlError !== 'object' || graphqlError === null) continue;
      const extensions = (graphqlError as { extensions?: unknown }).extensions;
      if (typeof extensions !== 'object' || extensions === null) continue;
      if ((extensions as { code?: unknown }).code === 'INTERNAL_SERVER_ERROR') return true;
    }
  }
  return false;
}

type InspectedResponse = {
  response: Response;
  /** True when the SERVER failed, as opposed to refusing what we asked it. */
  serverFailure: boolean;
};

/**
 * `authenticatedFetch` plus the one body read everything downstream needs.
 *
 * The body is parsed EXACTLY ONCE and both answers come out of it: whether
 * graphql-request is about to choke on it, and whether the backend just told us
 * it is broken. Two `response.clone().text()` passes would double the decode
 * cost of every request on the hot path.
 *
 * graphql-request's `runRequest` only wraps parse failures into a `ClientError`
 * for non-2xx responses; for a 2xx it re-throws the raw parse error (a
 * `SyntaxError` for an empty body, or an "Invalid execution result" `Error` for
 * a non-object/array body) — see `parseResultFromText` / `runRequest` in
 * graphql-request's `legacy/helpers/runRequest.ts`. That raw throw is exactly
 * the crash in #3190: an Android device going offline mid-request can get back
 * a `200` whose body never arrived. We peek via `response.clone().text()` (so
 * graphql-request can still read the original stream) and, for an `ok` response
 * only, replace an empty/malformed body with a typed `GraphQLEmptyResponseError`
 * before graphql-request ever sees it. Non-2xx responses are left untouched —
 * graphql-request already turns those into a `ClientError` without throwing.
 */
async function fetchAndInspect(url: string | URL | Request, options: RequestInit): Promise<InspectedResponse> {
  const response = await authenticatedFetch(url, options);
  if (!response.ok) {
    // A 4xx is the server answering (and refusing); a 5xx is the server failing.
    return { response, serverFailure: response.status >= 500 };
  }

  const parsedBody = parseResponseBody(await response.clone().text());
  if (parsedBody === undefined) throw new GraphQLEmptyResponseError(response.status);
  return { response, serverFailure: hasInternalServerErrorCode(parsedBody) };
}

async function inspectWithTimeout(
  url: string | URL | Request,
  options: RequestInit,
  timeoutMs: number | null,
): Promise<InspectedResponse> {
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    throw callerSignal.reason ?? createAbortError('GraphQL request aborted');
  }
  // `null` is the kill switch (`interactive-request-deadline` off): a marginal
  // link that legitimately takes longer than the deadline gets the old
  // wait-forever behaviour back, with none of the other three jobs of the gate
  // lost.
  if (timeoutMs === null) return fetchAndInspect(url, options);

  const requestController = new AbortController();
  let rejectCancellation: (reason: unknown) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const abortFromCaller = (): void => {
    const reason = callerSignal?.reason ?? createAbortError('GraphQL request aborted');
    requestController.abort(reason);
    rejectCancellation(reason);
  };
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    const error = createGraphqlTimeoutError(timeoutMs);
    requestController.abort(error);
    rejectCancellation(error);
  }, timeoutMs);

  try {
    return await Promise.race([fetchAndInspect(url, { ...options, signal: requestController.signal }), cancellation]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * THE fetch. Every GraphQL client in the app goes through this one function —
 * there is deliberately no thinner variant to reach for, because each of the
 * four things it does is something a call site would otherwise forget:
 *
 * 1. FAIL FAST while the app already knows the request cannot land — offline
 *    mode, no uplink, or a confirmed backend outage (issue #4862). The check
 *    runs BEFORE `authenticatedFetch`, which matters more than it looks: that
 *    function's first act is `ensureFreshToken()`, so an unchecked request to a
 *    dead backend would first spend a token refresh against that same dead
 *    backend, and every screen would wait out two dead round trips instead of
 *    none.
 * 2. DEADLINE it, so a wedged server cannot hold a spinner forever.
 * 3. GUARD the body, so graphql-request never chokes on a truncated 200 (#3190).
 * 4. FEED THE STORE. Every real request is a free reachability sample, which is
 *    what keeps the health probe rare: it only runs once ordinary traffic has
 *    already said something is wrong.
 */
export async function graphqlFetchGated(
  url: string | URL | Request,
  options: RequestInit = {},
  timeoutMs: number | null = INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const snapshot = getConnectivitySnapshot();
  if (snapshot.effectiveOffline) {
    // `reason` is non-null whenever `effectiveOffline` is — `deriveReason` in
    // the store guarantees it. The fallback keeps the types honest, but a null
    // here would misattribute a no-signal episode to our server in every
    // placard and event, so it is loud in dev rather than silent.
    if (snapshot.reason === null && __DEV__) {
      console.warn('[connectivity] effectiveOffline with no reason — deriveReason invariant broken');
    }
    throw new BackendUnavailableError(snapshot.reason ?? 'backend_unreachable');
  }

  try {
    const { response, serverFailure } = await inspectWithTimeout(url, options, timeoutMs);
    // A 4xx, and a 200 carrying ordinary GraphQL errors, are SUCCESSES here: the
    // server answered. Only a 5xx or an INTERNAL_SERVER_ERROR body says the
    // backend itself is in trouble.
    reportBackendOutcome(serverFailure ? { kind: 'failure', status: response.status } : { kind: 'success' });
    return response;
  } catch (error) {
    // A caller that cancelled its own request (a screen unmounting, a superseded
    // search) proves nothing about the server, and counting it would probe the
    // backend every time someone scrolls away from a list.
    if (options.signal?.aborted !== true) reportBackendOutcome({ kind: 'failure', error });
    throw error;
  }
}

export function createGraphQLHttpClient(): GraphQLClient {
  return new GraphQLClient(getGraphQLHttpUrl(), {
    // Read per request, not at client creation: the flag resolves after the
    // client singleton already exists.
    fetch: (url: string | URL | Request, options: RequestInit = {}) =>
      graphqlFetchGated(
        url,
        options,
        isInteractiveRequestDeadlineEnabled() ? INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS : null,
      ),
  });
}

export function createOfflineSyncGraphQLHttpClient(): GraphQLClient {
  return new GraphQLClient(getGraphQLHttpUrl(), {
    fetch: (url: string | URL | Request, options: RequestInit = {}) =>
      graphqlFetchGated(url, options, OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS),
  });
}

let httpClient: GraphQLClient | null = null;
let offlineSyncHttpClient: GraphQLClient | null = null;

export function getHttpClient(): GraphQLClient {
  if (!httpClient) {
    httpClient = createGraphQLHttpClient();
  }
  return httpClient;
}

export function getOfflineSyncHttpClient(): GraphQLClient {
  if (!offlineSyncHttpClient) {
    offlineSyncHttpClient = createOfflineSyncGraphQLHttpClient();
  }
  return offlineSyncHttpClient;
}

export function resetHttpClient(): void {
  httpClient = null;
  offlineSyncHttpClient = null;
}
