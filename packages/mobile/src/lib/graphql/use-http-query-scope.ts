import { useMemo } from 'react';
import { createHttpOperation } from './http-operation';
import { httpScopeQueryKey, isCurrentHttpView } from './request-scope';
import { isHttpCacheScoped, useHttpOperationScope } from './use-http-operation-scope';
import { createHttpQueryScope } from './http-query-scope';

/** Query and callback code share one captured view. Each invocation creates
 * its own operation so normal lease renewal cannot accumulate old receipts. */
export function useHttpQueryScope() {
  const scope = useHttpOperationScope();
  const scoped = isHttpCacheScoped();
  return useMemo(
    () =>
      createHttpQueryScope({
        scope,
        scoped,
        prefix: scoped ? httpScopeQueryKey([], scope) : [],
        isCurrentView: isCurrentHttpView,
        createOperation: (options) => createHttpOperation(scope, options),
      }),
    [scope, scoped],
  );
}

export type { HttpQueryScope, HttpQueryOperation } from './http-query-scope';
