import type { createBrowserBackendClient } from './browser-backend-client';
import { BrowserBackendConsumerError, type BrowserBackendConsumerScope } from './browser-backend-consumer';
import type { BrowserBackendLease } from './browser-backend-lease';
import { createBrowserBackendRequestAuthority } from './browser-backend-request-authority';

type BrowserClient = ReturnType<typeof createBrowserBackendClient>;
type LeaseAuthority = {
  readonly acquire: (this: void) => Promise<BrowserBackendLease>;
  readonly assertCurrent: (this: void, lease: unknown) => void;
  readonly isCurrent: (this: void) => boolean;
  readonly dispose: (this: void) => void;
  readonly refuse?: (this: void) => void;
};

/** The host SDK supplies only the response it actually decoded. Authority is
 * recovered from this transport's original Response headers, never these
 * fields, a reconstructed result, or serialized client metadata. */
export type BrowserBackendHttpObservation =
  | { readonly kind: 'error'; readonly headers?: unknown }
  | { readonly kind: 'result'; readonly headers: unknown; readonly data: unknown };

type Delivery = {
  readonly client: BrowserClient;
  readonly authority: LeaseAuthority;
  readonly lease: BrowserBackendLease;
  readonly signal: AbortSignal | null | undefined;
};
const deliveredResults = new WeakMap<object, Delivery>();

/** Retain the actual original delivery receipt through a caller's own awaits.
 * Ordinary legacy behavior remains separate; copied/serialized selected
 * results cannot borrow a current owner's or newer lease's authority. */
export function isCurrentBrowserBackendHttpResult(result: unknown, client: BrowserClient): boolean {
  if (client.getSnapshot().closed) return false;
  if (!client.isSelected()) return true;
  if (result === null || typeof result !== 'object') return false;
  const receipt = deliveredResults.get(result);
  if (!receipt || receipt.client !== client || receipt.signal?.aborted) return false;
  try {
    receipt.authority.assertCurrent(receipt.lease);
    return true;
  } catch {
    return false;
  }
}

/** undefined explicitly requests public access. Selected authenticated
 * uncertainty never proves an anonymous or legacy session. */
export function captureBrowserBackendHttpScope(
  authToken: string | null | undefined,
  client: BrowserClient,
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

function createHttpTransport(client: BrowserClient, performFetch: typeof fetch, source: LeaseAuthority) {
  let disposed = false;
  const authority: LeaseAuthority = {
    acquire: () => source.acquire(),
    assertCurrent(lease) {
      if (disposed) throw new BrowserBackendConsumerError('superseded');
      source.assertCurrent(lease);
    },
    isCurrent: () => !disposed && source.isCurrent(),
    dispose: () => source.dispose(),
  };
  const receipts = new WeakMap<object, { lease: BrowserBackendLease; signal: AbortSignal | null | undefined }>();
  return {
    fetch: (async (input, init) => {
      if (disposed) throw new BrowserBackendConsumerError('superseded');
      const requestedSignal = init?.signal;
      const signal = requestedSignal === undefined && input instanceof Request ? input.signal : requestedSignal;
      const lease = await authority.acquire();
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((contents, name) => headers.set(name, contents));
      headers.set('Authorization', 'Bearer ' + lease.token);
      authority.assertCurrent(lease);
      if (signal?.aborted) throw signal.reason ?? new Error('GraphQL request aborted');
      const response = await performFetch(input, { ...init, headers });
      try {
        authority.assertCurrent(lease);
        if (signal?.aborted) throw signal.reason ?? new Error('GraphQL request aborted');
        // Only the cold Expo view owns this policy. A confirmed refusal may
        // retire its exact live receipt, never an expired/aborted old request
        // or another account, and the command is never replayed.
        if (response.status === 401 && source.refuse) {
          source.refuse();
          throw new BrowserBackendConsumerError('denied');
        }
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      receipts.set(response.headers, { lease, signal });
      return response;
    }) satisfies typeof fetch,
    admitResponse(observed: BrowserBackendHttpObservation): void {
      const delivery =
        observed.headers !== null && typeof observed.headers === 'object' ? receipts.get(observed.headers) : undefined;
      const lease = delivery?.lease;
      // A generic parse/network error has no data to publish, but it must
      // still belong to the original current view.
      if (!lease && observed.kind === 'error') {
        if (!authority.isCurrent()) throw new BrowserBackendConsumerError('superseded');
        return;
      }
      if (!lease || !delivery) throw new BrowserBackendConsumerError('superseded');
      if (delivery.signal?.aborted) throw delivery.signal.reason ?? new Error('GraphQL request aborted');
      authority.assertCurrent(lease);
      if (observed.kind === 'result' && observed.data !== null && typeof observed.data === 'object') {
        const receipt = { client, authority, lease, signal: delivery.signal };
        deliveredResults.set(observed.data, receipt);
        for (const field of Object.values(observed.data).slice(0, 64))
          if (field !== null && typeof field === 'object') deliveredResults.set(field, receipt);
      }
    },
    /** View freshness only. Publishing data still requires its original
     * decoded-result receipt, including that delivery's actual lease. */
    isCurrent: () => authority.isCurrent(),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      authority.dispose();
    },
  };
}

/** Existing WWW callers already hold an original branded scope. The host SDK
 * adapter must call admitResponse after its real body decoder completes. */
export function createBrowserBackendHttpTransport(options: {
  readonly client: BrowserClient;
  readonly scope: BrowserBackendConsumerScope;
  readonly fetch: typeof fetch;
}) {
  const { client, scope, fetch: performFetch } = options;
  return createHttpTransport(client, performFetch, {
    acquire: () => client.acquireScope(scope),
    assertCurrent: (lease) => client.assertCurrent(scope, lease),
    isCurrent: () => client.isCurrent(scope),
    dispose: () => {},
  });
}

/** Pin the accepted view before a cold client's first actual lease exists.
 * Only the reviewed authority's real issued result may initialize its scope. */
export function createBrowserBackendHttpTransportForView(options: {
  readonly client: BrowserClient;
  readonly captureGeneration: () => number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly fetch: typeof fetch;
}) {
  const { client, fetch: performFetch } = options;
  const source = createBrowserBackendRequestAuthority(options);
  return createHttpTransport(client, performFetch, {
    acquire: () => source.acquire(),
    assertCurrent: (lease) => source.assertCurrent(lease),
    isCurrent: () => source.isCurrent(),
    dispose: () => source.dispose(),
    refuse: () => source.invalidate(),
  });
}
