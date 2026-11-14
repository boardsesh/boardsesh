import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import type { createHttpOperation, HttpOperationOptions } from './http-operation';
import { createHttpScopedCache } from './http-scoped-cache';

type Operation = Pick<
  ReturnType<typeof createHttpOperation>,
  'request' | 'assertView' | 'assertDeliveries' | 'dispose'
>;

/** Captured query identity and operation I/O. Only an operation's original
 * delivery guards can authorize effects after its own asynchronous work. */
export function createHttpQueryScope(options: {
  readonly scope: string | undefined;
  readonly scoped: boolean;
  readonly prefix: QueryKey;
  readonly isCurrentView: (scope: string | undefined) => boolean;
  readonly createOperation: (options?: HttpOperationOptions) => Operation;
}) {
  const { scope, scoped, isCurrentView, createOperation } = options;
  const prefix = Object.freeze([...options.prefix]);
  const assertView = () => {
    if (!isCurrentView(scope)) throw new BrowserBackendConsumerError('superseded');
  };
  const key = (queryKey: QueryKey): QueryKey => (scoped ? [...prefix, ...queryKey] : queryKey);
  const create = (requestOptions?: HttpOperationOptions) => {
    const operation = createOperation(requestOptions);
    return Object.freeze({
      ...operation,
      scoped,
      key,
      cache: (client: QueryClient) => createHttpScopedCache({ client, key, assertCurrent: operation.assertDeliveries }),
    });
  };
  return Object.freeze({
    scope,
    scoped,
    key,
    assertView,
    isReady: () => isCurrentView(scope),
    ownsKey: (queryKey: QueryKey) => !scoped || prefix.every((part, index) => queryKey[index] === part),
    cache: (client: QueryClient) => createHttpScopedCache({ client, key, assertCurrent: assertView }),
    create,
    async run<Result>(
      execute: (operation: ReturnType<typeof create>) => Promise<Result>,
      requestOptions?: HttpOperationOptions,
    ) {
      const operation = create(requestOptions);
      operation.assertView();
      const result = await execute(operation);
      operation.assertDeliveries();
      return Object.freeze({ result, assertCurrent: operation.assertDeliveries });
    },
  });
}

export type HttpQueryScope = ReturnType<typeof createHttpQueryScope>;
export type HttpQueryOperation = ReturnType<HttpQueryScope['create']>;
