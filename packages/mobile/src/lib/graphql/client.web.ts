import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  captureAuthCredentialGeneration,
  captureConfirmedWebAuthIdentity,
  hasConfirmedAnonymousWebSession,
  isAuthCredentialGenerationCurrent,
  isRequiredBrowserDispatch,
} from '../auth-store.web';
import { authenticatedFetch } from '../auth-interceptor.web';
import { expoBrowserBackendClient } from '../browser-backend-client.web';
import { getClientIdentityHeaderValue } from '../client-identity.web';
import { createBrowserHttpClientFacade } from './http-client-facade.web';
import { isInteractiveRequestDeadlineEnabled } from './request-timeout';
import * as legacy from './client-default';

export { isGraphqlRequestTimeoutError } from './request-timeout';
export {
  GraphQLEmptyResponseError,
  INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
  OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS,
} from './request-gate';
export { getGraphQLHttpUrl } from './client-default';

export const browserHttpClients = createBrowserHttpClientFacade({
  backendClient: expoBrowserBackendClient,
  captureGeneration: captureAuthCredentialGeneration,
  isGenerationCurrent: isAuthCredentialGenerationCurrent,
  captureIdentity: captureConfirmedWebAuthIdentity,
  confirmedAnonymous: hasConfirmedAnonymousWebSession,
  required: isRequiredBrowserDispatch,
  namespace() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new BrowserBackendConsumerError('unavailable');
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  },
  url: legacy.getGraphQLHttpUrl(),
  fetch: (...parameters) => fetch(...parameters),
  legacyFetch: authenticatedFetch,
  timeoutMs: (mode) =>
    mode === 'offline'
      ? legacy.OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS
      : isInteractiveRequestDeadlineEnabled()
        ? legacy.INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS
        : null,
  clientIdentity: getClientIdentityHeaderValue,
  legacy: {
    get: (mode) => (mode === 'offline' ? legacy.getOfflineSyncHttpClient() : legacy.getHttpClient()),
    reset: legacy.resetHttpClient,
  },
});

export const getHttpClient = browserHttpClients.getHttpClient;
export const getOfflineSyncHttpClient = browserHttpClients.getOfflineSyncHttpClient;
export const resetHttpClient = browserHttpClients.reset;

export function createGraphQLHttpClient() {
  return isRequiredBrowserDispatch() ? getHttpClient() : legacy.createGraphQLHttpClient();
}
export function createOfflineSyncGraphQLHttpClient() {
  return isRequiredBrowserDispatch() ? getOfflineSyncHttpClient() : legacy.createOfflineSyncGraphQLHttpClient();
}

/** No application caller uses this raw API. Selected publication requires the
 * actual SDK decoder and its receipt; there is no thinner selected escape. */
export const graphqlFetchGated: typeof legacy.graphqlFetchGated = (...parameters) => {
  if (isRequiredBrowserDispatch()) return Promise.reject(new BrowserBackendConsumerError('unavailable'));
  return legacy.graphqlFetchGated(...parameters);
};
