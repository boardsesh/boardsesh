import type { GraphQLClient } from 'graphql-request';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { createBrowserHttpOperation } from '@boardsesh/auth-protocol/browser-backend-http-operation';
import { createHttpOperationRequest } from './http-operation-sdk';
import type { HttpOperationOptions } from './http-operation';

/** All platform/client I/O is captured once. A supplied old view never resolves
 * through a newer account while its operation awaits work. */
export function createBrowserHttpOperations(options: {
  readonly captureScope: () => string | undefined;
  readonly isCurrentView: (scope: string | undefined) => boolean;
  readonly captureResult: (scope: string | undefined, result: unknown) => (() => void) | null;
  readonly captureErrorDelivery: (
    scope: string | undefined,
    error: unknown,
    requestIdentity: AbortSignal,
  ) => (() => void) | null;
  readonly resolveClient: (scope: string | undefined, mode: 'interactive' | 'offline') => GraphQLClient;
}) {
  const { captureScope, isCurrentView, captureResult, captureErrorDelivery, resolveClient } = options;
  function create(scope: string | undefined, options: HttpOperationOptions = {}) {
    const { mode = 'interactive', signal: callerSignal, assertDispatch } = options;
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const original = createBrowserHttpOperation({
      signal,
      assertView() {
        if (!isCurrentView(scope)) throw new BrowserBackendConsumerError('superseded');
      },
      captureDelivery: (result) => captureResult(scope, result),
      captureErrorDelivery: (error, requestIdentity) => captureErrorDelivery(scope, error, requestIdentity),
    });
    const request = createHttpOperationRequest({
      resolveClient: () => resolveClient(scope, mode),
      beginRequest: original.beginRequest,
      signal,
      assertDispatch,
    });
    return Object.freeze({
      scope,
      request,
      assertView: original.assertView,
      assertDeliveries: original.assertDeliveries,
      assertErrorDeliveries: original.assertErrorDeliveries,
      dispose() {
        original.dispose();
        controller.abort(new BrowserBackendConsumerError('superseded'));
      },
    });
  }
  return Object.freeze({
    create,
    capture: (options?: HttpOperationOptions) => create(captureScope(), options),
  });
}
