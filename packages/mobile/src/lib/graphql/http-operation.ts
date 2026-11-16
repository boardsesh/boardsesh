import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { getCredentialGeneration } from '../privacy/privacy-cache';
import { getHttpClient, getOfflineSyncHttpClient } from './client';
import { createHttpOperationRequest } from './http-operation-sdk';
import { createAbortError } from './request-timeout';

export type HttpOperationOptions = Readonly<{
  mode?: 'interactive' | 'offline';
  signal?: AbortSignal;
  /** Selected-web only: a restrictive original-continuation veto at dispatch. */
  assertDispatch?: () => void;
}>;

/** Native keeps its existing transport and account policy. The new operation
 * wrapper adds explicit caller cancellation without changing credential reads.
 *
 * A native operation outlives the screen that started it, but not the account:
 * a sign-in or sign-out aborts it at its next check. It then sends nothing more
 * under the next account's credentials, and its delivery, cache writes and
 * mutation callbacks all refuse, so a late response cannot publish the old
 * account's data after sign-out clears the cache. A generation check, not a
 * listener, so an operation the caller never disposes holds nothing. */
export function createHttpOperation(_scope: string | undefined, options: HttpOperationOptions = {}) {
  const { mode, signal: callerSignal } = options;
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const credentialGeneration = getCredentialGeneration();
  const assertActive = () => {
    if (credentialGeneration !== getCredentialGeneration() && !controller.signal.aborted)
      controller.abort(new BrowserBackendConsumerError('superseded'));
    if (signal.aborted) throw signal.reason ?? createAbortError('GraphQL operation aborted');
  };
  const request = createHttpOperationRequest({
    // Checked between the SDK's own signal checks, so an old account's request
    // is refused before it resolves the next account's client.
    resolveClient: () => {
      assertActive();
      return mode === 'offline' ? getOfflineSyncHttpClient() : getHttpClient();
    },
    beginRequest: () => ({ admit: () => {}, admitError: (_error: unknown) => {}, discard: () => {} }),
    signal,
  });
  return Object.freeze({
    scope: undefined,
    request,
    assertView: assertActive,
    assertDeliveries: assertActive,
    assertErrorDeliveries: (_error: unknown) => assertActive(),
    dispose: () => controller.abort(),
  });
}

export function captureHttpOperation(options?: HttpOperationOptions) {
  return createHttpOperation(undefined, options);
}

export type HttpOperation = ReturnType<typeof createHttpOperation>;
