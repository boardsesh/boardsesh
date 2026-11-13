import { ClientError, type ResponseMiddleware } from 'graphql-request';
import {
  BrowserBackendConsumerError,
  type BrowserBackendConsumerScope,
} from '@boardsesh/auth-protocol/browser-backend-consumer';
import type { BrowserBackendLease } from '@boardsesh/auth-protocol/browser-backend-lease';
import { browserBackendClient, type createBrowserBackendClient } from './browser-backend-client';

type BrowserClient = ReturnType<typeof createBrowserBackendClient>;
const deliveredResults = new WeakMap<
  object,
  {
    readonly client: BrowserClient;
    readonly scope: BrowserBackendConsumerScope;
    readonly lease: BrowserBackendLease;
    readonly signal: AbortSignal | null | undefined;
  }
>();

/** A caller's own await can resume after the transport's body check. Keep the
 * original delivery lease private so UI effects cannot borrow a newer lease. */
export function isCurrentBrowserBackendGraphQLResult(
  result: unknown,
  client: BrowserClient = browserBackendClient,
): boolean {
  if (client.getSnapshot().closed) return false;
  if (!client.isSelected()) return true;
  if (result === null || typeof result !== 'object') return false;
  const receipt = deliveredResults.get(result);
  if (!receipt || receipt.client !== client || receipt.signal?.aborted) return false;
  try {
    client.assertCurrent(receipt.scope, receipt.lease);
    return true;
  } catch {
    return false;
  }
}

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
  const receipts = new WeakMap<object, { lease: BrowserBackendLease; signal: AbortSignal | null | undefined }>();
  return {
    async fetch(input, init) {
      const requestedSignal = init?.signal;
      const signal = requestedSignal === undefined && input instanceof Request ? input.signal : requestedSignal;
      const lease = await options.client.acquireScope(options.scope);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((contents, name) => headers.set(name, contents));
      headers.set('Authorization', `Bearer ${lease.token}`);
      options.client.assertCurrent(options.scope, lease);
      if (signal?.aborted) throw signal.reason ?? new Error('GraphQL request aborted');
      const response = await options.fetch(input, { ...init, headers });
      try {
        options.client.assertCurrent(options.scope, lease);
        if (signal?.aborted) throw signal.reason ?? new Error('GraphQL request aborted');
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      receipts.set(response.headers, { lease, signal });
      return response;
    },
    responseMiddleware(response) {
      const headers =
        response instanceof ClientError
          ? response.response.headers
          : 'headers' in response
            ? response.headers
            : undefined;
      const delivery = headers && typeof headers === 'object' ? receipts.get(headers) : undefined;
      const lease = delivery?.lease;
      // A generic parsing/network error has no successful data to publish, but
      // it still must not publish an old actor's error into a newer account.
      if (!lease && response instanceof Error) {
        if (!options.client.isCurrent(options.scope)) throw new BrowserBackendConsumerError('superseded');
        return;
      }
      if (!lease || !delivery) throw new BrowserBackendConsumerError('superseded');
      if (delivery.signal?.aborted) throw delivery.signal.reason ?? new Error('GraphQL request aborted');
      options.client.assertCurrent(options.scope, lease);
      if (
        !(response instanceof Error) &&
        'data' in response &&
        response.data !== null &&
        typeof response.data === 'object'
      ) {
        const receipt = { client: options.client, scope: options.scope, lease, signal: delivery.signal };
        deliveredResults.set(response.data, receipt);
        // Existing callers return one operation's original object/array to a
        // second awaiting consumer. Carry that exact receipt across this one
        // projection, with a fixed bound rather than a recursive body walk.
        for (const field of Object.values(response.data).slice(0, 64))
          if (field !== null && typeof field === 'object') deliveredResults.set(field, receipt);
      }
    },
  };
}
