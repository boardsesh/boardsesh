import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  useQuery,
  useQueryClient,
  QueryObserver,
  type QueryKey,
  type QueryOptions,
  type Query,
  type QueryFunctionContext,
  type DefaultError,
} from '@tanstack/react-query';
import { createHttpOperation, type HttpOperation } from './http-operation';
import { useHttpQueryScope } from './use-http-query-scope';

// A temporary observer must not leave its invocation veto in shared options.
// Register before construction: reentrant commands can unwrap an older private
// frame instead of resurrecting it as their restoration baseline.
const finiteOptionFrames = new WeakMap<object, Readonly<{ baseline: Query['options'] }>>();

type HttpFiniteQuery<Result, Selected = Result> = {
  select?: (result: Result) => Selected;
  assertDispatch?: () => void;
  queryKey: QueryKey;
  queryFn: (operation: HttpOperation) => Promise<Result>;
  enabled: boolean;
  staleTime: number;
  refetchOnWindowFocus?: false;
};

/** This finite family needs the full operation's exact-error assertion after
 * its fanout settles. Its data is HTTP-only; no local result can mint a cause. */
export function useHttpFiniteQuery<Result, Selected = Result>({
  queryKey,
  queryFn,
  enabled,
  assertDispatch,
  ...behavior
}: HttpFiniteQuery<Result, Selected>) {
  const scope = useHttpQueryScope();
  const client = useQueryClient();
  const execute = async (context: QueryFunctionContext<QueryKey>, assertIntent?: () => void) => {
    assertIntent?.();
    scope.assertView();
    // Do not even read the signal getter in native/wholly legacy mode: the
    // original finite reads kept completing after their observer unmounted.
    const originalDispatch =
      scope.scoped && assertDispatch
        ? () => {
            assertIntent?.();
            scope.assertView();
            assertDispatch();
          }
        : undefined;
    const operation = createHttpOperation(
      scope.scope,
      scope.scoped
        ? {
            signal: context.signal,
            ...(originalDispatch ? { assertDispatch: originalDispatch } : {}),
          }
        : undefined,
    );
    try {
      assertIntent?.();
      operation.assertView();
      let result: Result;
      try {
        result = await queryFn(operation);
      } catch (error: unknown) {
        // Only this same invocation's authentic SDK error can become guidance.
        // The original continuation must also survive the complete body phase.
        if (scope.scoped) {
          operation.assertErrorDeliveries(error);
          originalDispatch?.();
        }
        throw error;
      }
      operation.assertDeliveries();
      // A dispatch veto is no permission to publish later. Recheck its same
      // original E1/reader after decoding, before TanStack sees any new bytes.
      originalDispatch?.();
      return result;
    } finally {
      // All finite physical work has settled. No retained page/updater receipt
      // is issued by this helper, unlike the separate paginated source API.
      operation.dispose();
    }
  };
  const bindOriginal = (
    assertIntent?: () => void,
    executeOriginal: typeof execute = execute,
  ): NonNullable<QueryOptions<Result, DefaultError, Result, QueryKey>['behavior']> => ({
    onFetch(context) {
      const originalContext: QueryFunctionContext<QueryKey> = {
        client: context.client,
        queryKey: context.queryKey,
        meta: context.options.meta,
        get signal() {
          return context.signal;
        },
      };
      // Bind execute itself. The core's default fetchFn consults mutable
      // Query.options.queryFn when resumed, after reentrant cache events.
      context.fetchFn = () => executeOriginal(originalContext, assertIntent);
    },
  });
  const original = {
    ...behavior,
    queryKey: scope.key(queryKey),
    queryFn: execute,
    enabled: enabled && scope.isReady(),
    ...(scope.scoped && assertDispatch ? { behavior: bindOriginal() } : {}),
  };
  const result = useQuery<Result, DefaultError, Selected>(original);
  const refetchOriginal = async (assertIntent?: () => void, options?: { requireFreshAfterJoin?: boolean }) => {
    const requireFresh = scope.scoped && options?.requireFreshAfterJoin === true;
    const assertOriginal = () => {
      assertIntent?.();
      scope.assertView();
    };
    assertOriginal();
    const beforeJoin = client.getQueryCache().find({ queryKey: original.queryKey, exact: true });
    const joining = scope.scoped && beforeJoin && beforeJoin.state.fetchStatus !== 'idle';
    if (joining) {
      const physical = beforeJoin.promise;
      // During a reentrant fetch event the retryer may not exist yet. Do not
      // graft this command's options into that other invocation's future retry.
      if (!physical) throw new BrowserBackendConsumerError('unavailable');
      await physical.catch(() => undefined);
      assertOriginal();
      if (client.getQueryCache().find({ queryKey: original.queryKey, exact: true }) !== beforeJoin)
        throw new BrowserBackendConsumerError('superseded');
      // Another independent flight can start while the joined promise settles.
      // Never install this command's options onto that new pending retryer.
      if (beforeJoin.state.fetchStatus !== 'idle') throw new BrowserBackendConsumerError('unavailable');
    }
    const previous = client.getQueryCache().find({ queryKey: original.queryKey, exact: true })?.options;
    const priorFrame = typeof previous?.queryFn === 'function' ? finiteOptionFrames.get(previous.queryFn) : undefined;
    // QueryCache erases Result to unknown. This cast only restores those exact
    // real option slots; it supplies no receipt, scope or accepting assertion.
    const baseline =
      priorFrame?.baseline ?? previous ?? (client.defaultQueryOptions(original) as unknown as Query['options']);
    let deliveredOwn = false;
    const commandQueryFn = async (context: QueryFunctionContext<QueryKey>) => {
      const delivered = await execute(context, assertIntent);
      // Scheduling correlation only: execute has already checked its original
      // actual success delivery. This flag never supplies network authority.
      deliveredOwn = true;
      return delivered;
    };
    const commandBehavior =
      scope.scoped && assertDispatch
        ? bindOriginal(assertIntent, commandQueryFn)
        : {
            onFetch(
              context: Parameters<
                NonNullable<QueryOptions<Result, DefaultError, Result, QueryKey>['behavior']>['onFetch']
              >[0],
            ) {
              const fetchOriginal = context.fetchFn;
              context.fetchFn = () => {
                assertOriginal();
                return fetchOriginal();
              };
            },
          };
    finiteOptionFrames.set(commandQueryFn, Object.freeze({ baseline }));
    let fixed: QueryObserver<Result, DefaultError, Selected> | undefined;
    try {
      fixed = new QueryObserver<Result, DefaultError, Selected>(client, {
        ...original,
        queryFn: commandQueryFn,
        behavior: commandBehavior,
        enabled: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: false,
      });
      assertOriginal();
      if (joining && !requireFresh) {
        // This is the actual settled Query result, not cached bytes presented
        // as a newly issued request. No observer was constructed while pending.
        fixed.updateResult();
        const observed = fixed.getCurrentResult();
        assertOriginal();
        return observed;
      }
      const pending = fixed.refetch({
        throwOnError: false,
        ...(scope.scoped && assertDispatch ? { cancelRefetch: false } : {}),
      });
      let held = false;
      let refusal: unknown;
      try {
        assertOriginal();
      } catch (error) {
        held = true;
        refusal = error;
      }
      const observed = await pending;
      if (held) throw refusal;
      assertOriginal();
      // Writer refresh must observe its own genuinely new guarded delivery.
      // cancelRefetch:false joining another flight does not satisfy freshness.
      if (requireFresh && !deliveredOwn) throw new BrowserBackendConsumerError('unavailable');
      return observed;
    } finally {
      // Erasure is the same public QueryCache view used above. Never look up a
      // replacement Query by key and overwrite its newer observer's options.
      const query = fixed
        ? (fixed.getCurrentQuery() as unknown as Query)
        : client.getQueryCache().find({ queryKey: original.queryKey, exact: true });
      fixed?.destroy();
      try {
        if (query) {
          const latest = query.options;
          const ownedFn = latest.queryFn === commandQueryFn;
          const ownedBehavior = latest.behavior === commandBehavior;
          if (ownedFn || ownedBehavior)
            query.setOptions({
              ...latest,
              ...(ownedFn ? { queryFn: baseline.queryFn } : {}),
              ...(ownedBehavior ? { behavior: baseline.behavior } : {}),
            });
        }
      } finally {
        finiteOptionFrames.delete(commandQueryFn);
      }
    }
  };
  return { ...result, refetchOriginal };
}
