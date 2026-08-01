import { GraphQLClient } from 'graphql-request';
import { GRAPHQL_EMPTY_RESPONSE_ERROR_NAME } from '@boardsesh/offline-sync/error-classification';
import { authenticatedFetch } from '../auth-interceptor';
import { BACKEND_URL } from '../env';

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
 * Wraps `authenticatedFetch` to guard against graphql-request's unguarded
 * `JSON.parse` on the response body. graphql-request's `runRequest` only
 * wraps parse failures into a `ClientError` for non-2xx responses; for a 2xx
 * response it re-throws the raw parse error (a `SyntaxError` for an empty
 * body, or an "Invalid execution result" `Error` for a non-object/array body)
 * — see `parseResultFromText` / `runRequest` in graphql-request's
 * `legacy/helpers/runRequest.ts`. That raw throw is exactly the crash in
 * #3190: an Android device going offline mid-request can get back a `200`
 * whose body never arrived.
 *
 * We peek the body via `response.clone().text()` (so graphql-request can
 * still read the original stream) and, for an `ok` response only, replace an
 * empty/malformed body with a typed `GraphQLEmptyResponseError` before
 * graphql-request ever sees it. Non-2xx responses are left untouched —
 * graphql-request already turns those into a `ClientError` without throwing.
 */
export async function graphqlFetchWithEmptyBodyGuard(
  url: string | URL | Request,
  options: RequestInit = {},
): Promise<Response> {
  const response = await authenticatedFetch(url, options);
  if (!response.ok) return response;

  const text = await response.clone().text();
  const trimmed = text.trim();
  let parsesToObjectOrArray = false;
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      parsesToObjectOrArray = typeof parsed === 'object' && parsed !== null;
    } catch {
      parsesToObjectOrArray = false;
    }
  }
  if (!parsesToObjectOrArray) throw new GraphQLEmptyResponseError(response.status);

  return response;
}

export function createGraphQLHttpClient(): GraphQLClient {
  return new GraphQLClient(getGraphQLHttpUrl(), {
    fetch: graphqlFetchWithEmptyBodyGuard,
  });
}

let httpClient: GraphQLClient | null = null;

export function getHttpClient(): GraphQLClient {
  if (!httpClient) {
    httpClient = createGraphQLHttpClient();
  }
  return httpClient;
}

export function resetHttpClient(): void {
  httpClient = null;
}
