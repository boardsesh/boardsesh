import type { QueryClient, QueryKey } from '@tanstack/react-query';

export type HttpScopedCache = Pick<
  QueryClient,
  | 'getQueryData'
  | 'getQueryState'
  | 'setQueryData'
  | 'setQueriesData'
  | 'cancelQueries'
  | 'invalidateQueries'
  | 'removeQueries'
>;

/** This facade exposes only scoped cache operations. The injected guard is
 * fixed to the original view or delivery, never a later hook render. */
export function createHttpScopedCache(options: {
  readonly client: QueryClient;
  readonly key: (key: QueryKey) => QueryKey;
  readonly assertCurrent: () => void;
}): HttpScopedCache {
  const { client, key, assertCurrent } = options;
  const queryKey = (candidate: unknown): QueryKey => {
    if (!Array.isArray(candidate)) throw new TypeError('Expected an original query key');
    return key(candidate);
  };
  const filters = (candidate: unknown) => {
    if (candidate !== undefined && (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)))
      throw new TypeError('Expected query filters');
    const original = candidate === undefined ? {} : { ...candidate };
    if ('predicate' in original && typeof original.predicate === 'function') {
      const predicate = original.predicate;
      original.predicate = (...parameters: unknown[]) => {
        assertCurrent();
        const matches: unknown = Reflect.apply(predicate, undefined, parameters);
        assertCurrent();
        return matches;
      };
    }
    return {
      ...original,
      queryKey: queryKey('queryKey' in original && original.queryKey !== undefined ? original.queryKey : []),
    };
  };
  const guardedUpdater = (candidate: unknown) => {
    if (typeof candidate !== 'function') return candidate;
    return (previous: unknown) => {
      assertCurrent();
      const next: unknown = Reflect.apply(candidate, undefined, [previous]);
      assertCurrent();
      return next;
    };
  };
  function synchronous<Method extends (...parameters: never[]) => unknown>(
    method: Method,
    shape: 'key' | 'filters',
    updater = false,
  ): Method {
    return new Proxy(method, {
      apply(target, _receiver, parameters: unknown[]) {
        assertCurrent();
        const supplied = [...parameters];
        supplied[0] = shape === 'key' ? queryKey(supplied[0]) : filters(supplied[0]);
        if (updater) supplied[1] = guardedUpdater(supplied[1]);
        const result: unknown = Reflect.apply(target, undefined, supplied);
        assertCurrent();
        return result;
      },
    });
  }
  function asynchronous<Method extends (...parameters: never[]) => unknown>(method: Method): Method {
    return new Proxy(method, {
      async apply(target, _receiver, parameters: unknown[]) {
        assertCurrent();
        const result: unknown = await Reflect.apply(target, undefined, [
          filters(parameters[0]),
          ...parameters.slice(1),
        ]);
        assertCurrent();
        return result;
      },
    });
  }
  return Object.freeze({
    getQueryData: synchronous(client.getQueryData.bind(client), 'key'),
    getQueryState: synchronous(client.getQueryState.bind(client), 'key'),
    setQueryData: synchronous(client.setQueryData.bind(client), 'key', true),
    setQueriesData: synchronous(client.setQueriesData.bind(client), 'filters', true),
    cancelQueries: asynchronous(client.cancelQueries.bind(client)),
    invalidateQueries: asynchronous(client.invalidateQueries.bind(client)),
    removeQueries: synchronous(client.removeQueries.bind(client), 'filters'),
  });
}
