import { getHttpClient, getOfflineSyncHttpClient } from './client';
import { createHttpOperationRequest } from './http-operation-sdk';
import { createAbortError } from './request-timeout';

export type HttpOperationOptions = Readonly<{
  mode?: 'interactive' | 'offline';
  signal?: AbortSignal;
}>;

/** Native keeps its existing transport and account policy. The new operation
 * wrapper adds explicit caller cancellation without changing credential reads. */
export function createHttpOperation(_scope: string | undefined, options: HttpOperationOptions = {}) {
  const { mode, signal: callerSignal } = options;
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const assertActive = () => {
    if (signal.aborted) throw signal.reason ?? createAbortError('GraphQL operation aborted');
  };
  const request = createHttpOperationRequest({
    resolveClient: () => (mode === 'offline' ? getOfflineSyncHttpClient() : getHttpClient()),
    beginRequest: () => ({ admit: () => {}, discard: () => {} }),
    signal,
  });
  return Object.freeze({
    scope: undefined,
    request,
    assertView: assertActive,
    assertDeliveries: assertActive,
    dispose: () => controller.abort(),
  });
}

export function captureHttpOperation(options?: HttpOperationOptions) {
  return createHttpOperation(undefined, options);
}

export type HttpOperation = ReturnType<typeof createHttpOperation>;
