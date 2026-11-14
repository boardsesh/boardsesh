import { GraphQLClient } from 'graphql-request';
import { authenticatedFetch } from '../auth-interceptor';
import { BACKEND_URL } from '../env';
import { isInteractiveRequestDeadlineEnabled } from './request-timeout';
import {
  createGraphQLRequestGate,
  INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
  OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS,
} from './request-gate';

export { isGraphqlRequestTimeoutError } from './request-timeout';
export {
  GraphQLEmptyResponseError,
  INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
  OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS,
} from './request-gate';

export function getGraphQLHttpUrl(): string {
  return `${BACKEND_URL}/graphql`;
}

export const graphqlFetchGated = createGraphQLRequestGate({ fetch: authenticatedFetch });

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

export function getHttpClient(_scope?: string | null): GraphQLClient;
export function getHttpClient(): GraphQLClient {
  if (!httpClient) {
    httpClient = createGraphQLHttpClient();
  }
  return httpClient;
}

export function getOfflineSyncHttpClient(_scope?: string | null): GraphQLClient;
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
