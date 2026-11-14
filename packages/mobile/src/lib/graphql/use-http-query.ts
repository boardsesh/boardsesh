import {
  useQuery,
  useInfiniteQuery,
  type DefaultError,
  type InfiniteData,
  type QueryFunctionContext,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { useHttpQueryScope, type HttpQueryOperation } from './use-http-query-scope';

// Initial/placeholder data and custom key hashing require an explicit ownership
// contract. They are deliberately absent from this network-only adapter.
type SharedOptions = 'select' | 'gcTime' | 'retry' | 'retryDelay' | 'networkMode' | 'meta' | 'notifyOnChangeProps';

type Scheduling = {
  enabled?: boolean;
  staleTime?: number;
  refetchOnMount?: boolean | 'always';
  refetchOnWindowFocus?: boolean | 'always';
  refetchOnReconnect?: boolean | 'always';
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
};

type HttpQueryContext<Key extends QueryKey, Page = never> = Omit<QueryFunctionContext<QueryKey, Page>, 'queryKey'> & {
  queryKey: Key;
};

export type HttpQueryOptions<QueryResult, Error, SelectedResult, Key extends QueryKey> = Pick<
  UseQueryOptions<QueryResult, Error, SelectedResult, QueryKey>,
  SharedOptions
> &
  Scheduling & {
    queryKey: Key;
    queryFn: (context: HttpQueryContext<Key>, operation: HttpQueryOperation) => Promise<QueryResult>;
  };

/** The original view is fixed before TanStack invokes its asynchronous query.
 * Cache/effect work inside queryFn uses operation.cache/assertDeliveries too. */
export function useHttpQuery<
  QueryResult,
  Error = DefaultError,
  SelectedResult = QueryResult,
  Key extends QueryKey = QueryKey,
>(options: HttpQueryOptions<QueryResult, Error, SelectedResult, Key>): UseQueryResult<SelectedResult, Error> {
  const scope = useHttpQueryScope();
  const { queryFn, queryKey, enabled = true, ...behavior } = options;
  return useQuery<QueryResult, Error, SelectedResult, QueryKey>({
    ...behavior,
    queryKey: scope.key(queryKey),
    enabled: enabled && scope.isReady(),
    queryFn: async (context) => {
      const operation = scope.create({ signal: context.signal });
      operation.assertView();
      const result = await queryFn({ ...context, queryKey }, operation);
      operation.assertDeliveries();
      return result;
    },
  });
}

export type HttpInfiniteQueryOptions<QueryResult, Error, SelectedResult, Key extends QueryKey, Page> = Pick<
  UseInfiniteQueryOptions<QueryResult, Error, SelectedResult, QueryKey, Page>,
  SharedOptions | 'initialPageParam' | 'getNextPageParam' | 'getPreviousPageParam' | 'maxPages'
> &
  Scheduling & {
    queryKey: Key;
    queryFn: (context: HttpQueryContext<Key, Page>, operation: HttpQueryOperation) => Promise<QueryResult>;
  };

export function useHttpInfiniteQuery<
  QueryResult,
  Error = DefaultError,
  SelectedResult = InfiniteData<QueryResult>,
  Key extends QueryKey = QueryKey,
  Page = unknown,
>(
  options: HttpInfiniteQueryOptions<QueryResult, Error, SelectedResult, Key, Page>,
): UseInfiniteQueryResult<SelectedResult, Error> {
  const scope = useHttpQueryScope();
  const { queryFn, queryKey, enabled = true, ...behavior } = options;
  return useInfiniteQuery<QueryResult, Error, SelectedResult, QueryKey, Page>({
    ...behavior,
    queryKey: scope.key(queryKey),
    enabled: enabled && scope.isReady(),
    queryFn: async (context) => {
      const operation = scope.create({ signal: context.signal });
      operation.assertView();
      const result = await queryFn({ ...context, queryKey }, operation);
      operation.assertDeliveries();
      return result;
    },
  });
}
