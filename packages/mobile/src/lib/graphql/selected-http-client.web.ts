import { ClientError, GraphQLClient } from 'graphql-request';
import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  createBrowserBackendHttpTransportForView,
  captureBrowserBackendHttpResult,
  isCurrentBrowserBackendHttpResult,
} from '@boardsesh/auth-protocol/browser-backend-http';
import { CLIENT_IDENTITY_HEADER } from '@boardsesh/shared-schema/client-identity';
import { reportBackendOutcome } from '../connectivity/connectivity-store';
import { createGraphQLRequestGate } from './request-gate';

/** A fixed-view client may exist before its first actual lease. Only the
 * shared authority can acquire that lease; a later login cannot initialize it.
 * Platform/network I/O is injected, and no bearer is returned or persisted. */
export function createSelectedBrowserHttpClient(options: {
  readonly backendClient: ReturnType<typeof createBrowserBackendClient>;
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly captureGeneration: () => number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly timeoutMs: () => number | null;
  readonly clientIdentity: () => string;
}) {
  const { backendClient, url, fetch: performFetch, timeoutMs, clientIdentity } = options;
  const controller = new AbortController();
  const transport = createBrowserBackendHttpTransportForView({
    client: backendClient,
    captureGeneration: options.captureGeneration,
    isGenerationCurrent: options.isGenerationCurrent,
    onConfirmedRefusal: () => reportBackendOutcome({ kind: 'success' }),
    async fetch(input, init) {
      const headers = new Headers(init?.headers);
      headers.set(CLIENT_IDENTITY_HEADER, clientIdentity());
      return performFetch(input, { ...init, headers });
    },
  });
  const gatedFetch = createGraphQLRequestGate({
    fetch: transport.fetch,
    // The deadline gate removes its temporary caller listener after inspection.
    // A browser-composed signal still retains the original caller's cancellation
    // through actual SDK decoding and the consumer's own later awaits.
    composeSignal: (caller, deadline) => (caller ? AbortSignal.any([caller, deadline]) : deadline),
    // A source/owner refusal can happen before a GraphQL packet exists. Only
    // the shared core's actual-live-401 observer confirms reachability.
    ignoreFailure: (error) => error instanceof BrowserBackendConsumerError,
  });
  const client = new GraphQLClient(url, {
    fetch(input, init = {}) {
      // graphql-request exposes setEndpoint(). This view's credential belongs
      // only to its configured backend, even if a caller mutates that SDK API.
      const destination = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (destination !== url) throw new BrowserBackendConsumerError('unavailable');
      const caller = init.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = AbortSignal.any(caller ? [caller, controller.signal] : [controller.signal]);
      return gatedFetch(input, { ...init, signal }, timeoutMs());
    },
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
  });
  return Object.freeze({
    client,
    isCurrent: transport.isCurrent,
    /** Check synchronously after every caller-owned await and immediately
     * before state/cache/effect publication. Copies supply no authority. */
    isCurrentResult: (result: unknown) =>
      transport.isCurrent() && isCurrentBrowserBackendHttpResult(result, backendClient),
    captureResult(result: unknown): (() => void) | null {
      if (!transport.isCurrent()) return null;
      const assertResult = captureBrowserBackendHttpResult(result, backendClient);
      if (!assertResult) return null;
      return () => {
        if (!transport.isCurrent()) throw new BrowserBackendConsumerError('superseded');
        assertResult();
      };
    },
    dispose(): void {
      if (controller.signal.aborted) return;
      transport.dispose();
      controller.abort(new BrowserBackendConsumerError('superseded'));
    },
  });
}
