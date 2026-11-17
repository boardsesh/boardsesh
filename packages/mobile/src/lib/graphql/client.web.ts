import { GraphQLClient } from 'graphql-request';
import { authenticatedFetch } from '../auth-interceptor.web';
import { isSessionSupersededError } from '../browser-session-guard.web';
import { isInteractiveRequestDeadlineEnabled } from './request-timeout';
import {
  createGraphQLRequestGate,
  INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
  OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS,
} from './request-gate';
import { getGraphQLHttpUrl } from './client-default';

export { isGraphqlRequestTimeoutError } from './request-timeout';
export {
  GraphQLEmptyResponseError,
  INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
  OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS,
} from './request-gate';
export { getGraphQLHttpUrl } from './client-default';

/** client-default's gate, plus one rule: a response dropped because the
 * browser session changed says nothing about the backend's health. */
export const graphqlFetchGated = createGraphQLRequestGate({
  fetch: authenticatedFetch,
  ignoreFailure: isSessionSupersededError,
});

export function createGraphQLHttpClient(): GraphQLClient {
  return new GraphQLClient(getGraphQLHttpUrl(), {
    // Read per request: the flag resolves after the client singleton exists.
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
  httpClient ??= createGraphQLHttpClient();
  return httpClient;
}

export function getOfflineSyncHttpClient(): GraphQLClient {
  offlineSyncHttpClient ??= createOfflineSyncGraphQLHttpClient();
  return offlineSyncHttpClient;
}

export function resetHttpClient(): void {
  httpClient = null;
  offlineSyncHttpClient = null;
}
