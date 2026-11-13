import { ClientError, type ResponseMiddleware } from 'graphql-request';
import {
  BrowserBackendConsumerError,
  type BrowserBackendConsumerScope,
} from '@boardsesh/auth-protocol/browser-backend-consumer';
import type { BrowserBackendLease } from '@boardsesh/auth-protocol/browser-backend-lease';
import { browserBackendClient, type createBrowserBackendClient } from './browser-backend-client';

type BrowserClient = ReturnType<typeof createBrowserBackendClient>;

/** undefined is an explicitly public request. A recognized selected bearer or
 * a previously selected authenticated caller can never become legacy/anonymous
 * because its in-memory receipt is missing or expired. */
export function captureBrowserBackendRequestScope(
  authToken: string | null | undefined,
  client: BrowserClient = browserBackendClient,
): BrowserBackendConsumerScope | null {
  if (authToken && (authToken.startsWith('bsbd1_') || client.isSelected())) {
    const scope = client.capture(authToken);
    if (!scope) throw new BrowserBackendConsumerError('superseded');
    return scope;
  }
  if (authToken === null && client.isSelected() && !client.isAnonymous())
    throw new BrowserBackendConsumerError('unavailable');
  return null;
}

/** Both halves are required: fetch checks before send/after response headers;
 * graphql-request's middleware checks again after the actual response body and
 * JSON parser complete. Each response owns its receipt, including concurrency.
 * UI/cache callers still need their owner barrier after their own await. */
export function createBrowserBackendGraphQLTransport(options: {
  readonly client: BrowserClient;
  readonly scope: BrowserBackendConsumerScope;
  readonly fetch: typeof fetch;
}): { fetch: typeof fetch; responseMiddleware: ResponseMiddleware } {
  const receipts = new WeakMap<object, BrowserBackendLease>();
  return {
    async fetch(input, init) {
      const lease = await options.client.acquireScope(options.scope);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((contents, name) => headers.set(name, contents));
      headers.set('Authorization', `Bearer ${lease.token}`);
      options.client.assertCurrent(options.scope, lease);
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error('GraphQL request aborted');
      const response = await options.fetch(input, { ...init, headers });
      try {
        options.client.assertCurrent(options.scope, lease);
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      receipts.set(response.headers, lease);
      return response;
    },
    responseMiddleware(response) {
      const headers =
        response instanceof ClientError
          ? response.response.headers
          : 'headers' in response
            ? response.headers
            : undefined;
      const lease = headers && typeof headers === 'object' ? receipts.get(headers) : undefined;
      // A generic parsing/network error has no successful data to publish, but
      // it still must not publish an old actor's error into a newer account.
      if (!lease && response instanceof Error) {
        if (!options.client.isCurrent(options.scope)) throw new BrowserBackendConsumerError('superseded');
        return;
      }
      options.client.assertCurrent(options.scope, lease);
    },
  };
}
