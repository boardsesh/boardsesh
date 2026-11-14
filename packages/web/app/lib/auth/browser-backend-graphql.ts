import { ClientError, type ResponseMiddleware } from 'graphql-request';
import type { BrowserBackendConsumerScope } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  captureBrowserBackendHttpScope,
  createBrowserBackendHttpTransport,
  isCurrentBrowserBackendHttpResult,
} from '@boardsesh/auth-protocol/browser-backend-http';
import { browserBackendClient, type createBrowserBackendClient } from './browser-backend-client';

type BrowserClient = ReturnType<typeof createBrowserBackendClient>;

export function isCurrentBrowserBackendGraphQLResult(
  result: unknown,
  client: BrowserClient = browserBackendClient,
): boolean {
  return isCurrentBrowserBackendHttpResult(result, client);
}

export function captureBrowserBackendRequestScope(
  authToken: string | null | undefined,
  client: BrowserClient = browserBackendClient,
): BrowserBackendConsumerScope | null {
  return captureBrowserBackendHttpScope(authToken, client);
}

/** graphql-request owns decoding and its Error class. The shared core owns the
 * original actual response, lease and result receipts across host SDKs. */
export function createBrowserBackendGraphQLTransport(options: {
  readonly client: BrowserClient;
  readonly scope: BrowserBackendConsumerScope;
  readonly fetch: typeof fetch;
}): { fetch: typeof fetch; responseMiddleware: ResponseMiddleware } {
  const transport = createBrowserBackendHttpTransport(options);
  return {
    fetch: transport.fetch,
    responseMiddleware(response) {
      const headers =
        response instanceof ClientError
          ? response.response.headers
          : 'headers' in response
            ? response.headers
            : undefined;
      if (response instanceof Error) transport.admitResponse({ kind: 'error', headers });
      else transport.admitResponse({ kind: 'result', headers, data: 'data' in response ? response.data : undefined });
    },
  };
}
