import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  InfiniteQueryObserver,
  type QueryClient,
  type Query,
  type InfiniteQueryObserverOptions,
  type DefaultError,
  type InfiniteData,
  type QueryFunctionContext,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpQueryScope, type HttpQueryOperation, type HttpQueryScope } from './use-http-query-scope';

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
    /** Explicit original native policy; receives the actual untouched context. */
    nativeQueryFn?: (context: QueryFunctionContext<QueryKey, Page>) => Promise<QueryResult>;
  };

/** A page handle owns references, while its pure assertions remain repeatable
 * for an already captured React updater. Releasing it cannot mint another job. */
export type HttpPageConsumer = Readonly<{
  assertCurrent: () => void;
  retain: () => HttpPageConsumer;
  acknowledge: () => void;
  release: () => void;
}>;
export type HttpPageData<Result, Param> = Readonly<{
  pages: readonly Result[];
  pageParams: readonly Param[];
}>;
export type HttpPageSnapshot<Result, Param> = Readonly<{
  data: HttpPageData<Result, Param>;
  hasMore: boolean;
  assertCurrent: () => void;
  retain: () => HttpPageConsumer;
}>;
export type HttpPageOutcome<Result, Param> =
  | ({ status: 'delivered'; consumer: HttpPageConsumer } & HttpPageSnapshot<Result, Param>)
  | { status: 'no-progress'; reason: 'joined-refetch' | 'no-network' }
  | { status: 'held'; reason: 'retired' | 'offset-basis-changed' | 'unproven-page' };
export type HttpInfinitePageSource<Result, Param> = Readonly<{
  kind: 'scoped' | 'legacy';
  identity: object;
  assertView: () => void;
  read: () => HttpPageSnapshot<Result, Param>;
  fetchNextPage: (options?: { signal?: AbortSignal }) => Promise<HttpPageOutcome<Result, Param>>;
  dispose: () => void;
}>;
export type HttpInfiniteQueryWithPages<Result, Error, Param> = UseInfiniteQueryResult<
  InfiniteData<Result, Param>,
  Error
> & { capturePageSource: () => HttpInfinitePageSource<Result, Param> };

type PageProof = Readonly<{
  page: object;
  group: object;
  parameter: unknown;
  operation: HttpQueryOperation;
}>;
type PageGroup = {
  query: Query;
  identity: object;
  promise: Promise<unknown>;
  proofs: Set<PageProof>;
  retired: boolean;
  failure?: Readonly<{ error: unknown; assertCurrent?: () => void; dispose: () => void }>;
};
type PageLedger = {
  pages: WeakMap<object, PageProof>;
  pending: Map<AbortSignal, PageGroup>;
  consumers: number;
};
const queryLedgers = new WeakMap<QueryClient, WeakMap<Query, PageLedger>>();
const heldPages = new WeakSet<object>();
function pageHeld(): Error {
  const error = new Error('The original paginated read is unavailable');
  error.name = 'AbortError';
  heldPages.add(error);
  return error;
}
export function isHttpPageHeld(error: unknown): boolean {
  return error !== null && typeof error === 'object' && heldPages.has(error);
}
function ledgerFor(client: QueryClient, query: Query): PageLedger {
  let queries = queryLedgers.get(client);
  if (!queries) {
    queries = new WeakMap();
    queryLedgers.set(client, queries);
  }
  let ledger = queries.get(query);
  if (!ledger) {
    ledger = { pages: new WeakMap(), pending: new Map(), consumers: 0 };
    queries.set(query, ledger);
  }
  return ledger;
}
function objectPage(page: unknown): object | null {
  return page !== null && typeof page === 'object' ? page : null;
}
function pageGroup(ledger: PageLedger, query: Query, signal: AbortSignal): PageGroup {
  const promise = query.promise;
  if (!promise) throw pageHeld();
  const previous = ledger.pending.get(signal);
  if (previous) {
    if (previous.promise !== promise) throw pageHeld();
    return previous;
  }
  const group: PageGroup = { query, identity: Object.freeze({}), promise, proofs: new Set(), retired: false };
  ledger.pending.set(signal, group);
  const settled = (failed: boolean) => {
    if (ledger.pending.get(signal) === group) ledger.pending.delete(signal);
    if (failed) for (const proof of group.proofs) proof.operation.dispose();
    group.failure?.dispose();
    group.failure = undefined;
    group.proofs.clear();
  };
  void promise.then(
    () => settled(false),
    () => settled(true),
  );
  return group;
}

function readPageFailure(group: PageGroup): PageGroup['failure'] {
  return group.failure;
}
function clearPageFailure(group: PageGroup): void {
  group.failure?.dispose();
  group.failure = undefined;
}

/** Diagnostics expose counts only, never page objects, guards or credentials. */
export function httpPageSourceDiagnostics(client: QueryClient, key: QueryKey) {
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  const ledger = query && queryLedgers.get(client)?.get(query);
  return { pendingGroups: ledger?.pending.size ?? 0, consumers: ledger?.consumers ?? 0 };
}

function captureFixedPageSource<Result, Error, Param>(
  client: QueryClient,
  scope: HttpQueryScope,
  options: InfiniteQueryObserverOptions<Result, Error, InfiniteData<Result, Param>, QueryKey, Param>,
): HttpInfinitePageSource<Result, Param> {
  scope.assertView();
  const observer = new InfiniteQueryObserver<Result, Error, InfiniteData<Result, Param>, QueryKey, Param>(client, {
    ...options,
    enabled: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
  if (!query) {
    unsubscribe();
    observer.destroy();
    throw pageHeld();
  }
  const ledger = ledgerFor(client, query);
  const initial = observer.getCurrentResult().data;
  const freezeSnapshot = (pages: readonly Result[], pageParams: readonly Param[]): HttpPageData<Result, Param> =>
    Object.freeze({ pages: Object.freeze([...pages]), pageParams: Object.freeze([...pageParams]) });
  let snapshot = freezeSnapshot(initial?.pages ?? [], initial?.pageParams ?? []);
  const uncommitted = new Map<object, PageProof>();
  const lifetime = new AbortController();
  let disposed = false;
  let users = 0;
  let stopped = false;
  const assertView = () => {
    if (disposed) throw pageHeld();
    try {
      scope.assertView();
    } catch {
      throw pageHeld();
    }
  };
  const finish = () => {
    if (!disposed || users || stopped) return;
    stopped = true;
    unsubscribe();
    observer.destroy();
    uncommitted.clear();
    snapshot = freezeSnapshot([], []);
  };
  const assertProofs = (proofs: readonly PageProof[]) => {
    assertView();
    for (const proof of proofs) {
      try {
        proof.operation.assertDeliveries();
      } catch {
        throw pageHeld();
      }
    }
    assertView();
  };
  const nextParameter = (current: HttpPageData<Result, Param>): Param | undefined | null => {
    if (!current.pages.length) return options.initialPageParam;
    return options.getNextPageParam(
      current.pages[current.pages.length - 1],
      [...current.pages],
      current.pageParams[current.pageParams.length - 1],
      [...current.pageParams],
    );
  };
  const consumer = (proofs: readonly PageProof[]): HttpPageConsumer => {
    ledger.consumers += 1;
    let released = false;
    const assertCurrent = () => assertProofs(proofs);
    return Object.freeze({
      assertCurrent,
      retain() {
        if (released) throw pageHeld();
        assertCurrent();
        return consumer(proofs);
      },
      acknowledge() {
        assertCurrent();
        for (const [page, proof] of uncommitted) if (proofs.includes(proof)) uncommitted.delete(page);
      },
      release() {
        if (released) return;
        released = true;
        ledger.consumers -= 1;
        // The successful page owns immutable original provenance. Do not
        // dispose it here: another waiter/React replay may still need it.
      },
    });
  };
  const read = (): HttpPageSnapshot<Result, Param> => {
    const proofs = [...uncommitted.values()];
    assertProofs(proofs);
    return Object.freeze({
      data: snapshot,
      hasMore: nextParameter(snapshot) != null,
      assertCurrent: () => assertProofs(proofs),
      retain: () => consumer(proofs),
    });
  };
  return Object.freeze({
    kind: scope.scoped ? 'scoped' : 'legacy',
    identity: Object.freeze({}),
    assertView,
    read,
    async fetchNextPage(caller: { signal?: AbortSignal } = {}): Promise<HttpPageOutcome<Result, Param>> {
      try {
        assertView();
      } catch {
        return { status: 'held', reason: 'retired' };
      }
      if (caller.signal?.aborted) return { status: 'held', reason: 'retired' };
      const before = snapshot;
      const expected = nextParameter(before);
      if (expected == null) return { status: 'no-progress', reason: 'no-network' };
      const observed = observer.getCurrentResult().data;
      if (
        scope.scoped &&
        observed &&
        (!Object.is(nextParameter(observed), expected) ||
          before.pageParams.some((parameter, index) => !Object.is(parameter, observed.pageParams[index])))
      )
        return { status: 'held', reason: 'offset-basis-changed' };
      users += 1;
      let interrupt: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        interrupt = () => reject(pageHeld());
      });
      lifetime.signal.addEventListener('abort', interrupt!, { once: true });
      caller.signal?.addEventListener('abort', interrupt!, { once: true });
      try {
        const pending = observer.fetchNextPage({ cancelRefetch: false });
        const actualPromise = query.promise;
        const group = [...ledger.pending.values()].find((candidate) => candidate.promise === actualPromise);
        const result = await Promise.race([pending, cancelled]);
        assertView();
        if (result.isError) throw result.error;
        if (!result.data) return { status: 'no-progress', reason: 'no-network' };
        if (!scope.scoped) {
          snapshot = freezeSnapshot(result.data.pages, result.data.pageParams);
          const owner = consumer([]);
          return { status: 'delivered', ...read(), consumer: owner };
        }
        if (before.pageParams.some((parameter, index) => !Object.is(parameter, result.data!.pageParams[index])))
          return { status: 'held', reason: 'offset-basis-changed' };
        const candidates = result.data.pages.flatMap((page, index) => {
          const object = objectPage(page);
          const proof = object && ledger.pages.get(object);
          return proof &&
            proof.group === group?.identity &&
            Object.is(proof.parameter, expected) &&
            Object.is(result.data!.pageParams[index], expected) &&
            !before.pages.includes(page)
            ? [{ page, object: object!, proof }]
            : [];
        });
        if (!candidates.length) return { status: 'no-progress', reason: group ? 'joined-refetch' : 'no-network' };
        if (candidates.length !== 1) return { status: 'held', reason: 'unproven-page' };
        const found = candidates[0];
        // A mutable cache/refetch may not move a fixed source's offset basis.
        const expectedIndex = result.data.pageParams.findIndex((parameter) => Object.is(parameter, expected));
        const prefix = {
          pages: result.data.pages.slice(0, expectedIndex),
          pageParams: result.data.pageParams.slice(0, expectedIndex),
        };
        if (expectedIndex !== before.pages.length || !Object.is(nextParameter(prefix), expected))
          return { status: 'held', reason: 'offset-basis-changed' };
        const proofs = [...uncommitted.values(), found.proof];
        assertProofs(proofs);
        // Only this exact expected page advances the private snapshot. Never
        // replace its prefix with a joined refetch's unqualified cached rows.
        snapshot = freezeSnapshot([...before.pages, found.page], [...before.pageParams, expected]);
        uncommitted.set(found.object, found.proof);
        const owner = consumer(proofs);
        return { status: 'delivered', ...read(), consumer: owner };
      } catch (error) {
        if (isHttpPageHeld(error)) return { status: 'held', reason: 'retired' };
        throw error;
      } finally {
        lifetime.signal.removeEventListener('abort', interrupt!);
        caller.signal?.removeEventListener('abort', interrupt!);
        users -= 1;
        finish();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort(pageHeld());
      finish();
    },
  });
}

export function useHttpInfiniteQuery<Result, Error = DefaultError, Key extends QueryKey = QueryKey, Param = unknown>(
  options: HttpInfiniteQueryOptions<Result, Error, InfiniteData<Result, Param>, Key, Param> & {
    pageDelivery: true;
    select?: never;
  },
): HttpInfiniteQueryWithPages<Result, Error, Param>;
export function useHttpInfiniteQuery<
  Result,
  Error = DefaultError,
  Selected = InfiniteData<Result>,
  Key extends QueryKey = QueryKey,
  Param = unknown,
>(
  options: HttpInfiniteQueryOptions<Result, Error, Selected, Key, Param> & { pageDelivery?: false },
): UseInfiniteQueryResult<Selected, Error>;
export function useHttpInfiniteQuery<
  Result,
  Error = DefaultError,
  Selected = InfiniteData<Result>,
  Key extends QueryKey = QueryKey,
  Param = unknown,
>(
  options: HttpInfiniteQueryOptions<Result, Error, Selected, Key, Param> & { pageDelivery?: boolean },
): UseInfiniteQueryResult<Selected, Error> | HttpInfiniteQueryWithPages<Result, Error, Param> {
  const scope = useHttpQueryScope();
  const client = useQueryClient();
  const { queryFn, nativeQueryFn, queryKey, enabled = true, pageDelivery = false, ...behavior } = options;
  const actualKey = scope.key(queryKey);
  const strictBatch = pageDelivery && scope.scoped;
  const activeBatches = new WeakMap<AbortSignal, Readonly<{ group: PageGroup; ledger: PageLedger }>>();
  const assertBatch = (group: PageGroup, retained: Iterable<PageProof> = group.proofs) => {
    if (group.retired) throw pageHeld();
    try {
      scope.assertView();
      if (client.getQueryCache().find({ queryKey: actualKey, exact: true }) !== group.query) throw pageHeld();
      for (const proof of retained) proof.operation.assertDeliveries();
      scope.assertView();
    } catch {
      group.retired = true;
      throw pageHeld();
    }
  };
  const wrappedQuery = async (context: QueryFunctionContext<QueryKey, Param>) => {
    // Do not read or spread the getter here. These four future native callers
    // deliberately finish and populate their raw cache after observer deletion.
    if (!scope.scoped && nativeQueryFn) {
      scope.assertView();
      try {
        return await nativeQueryFn(context);
      } finally {
        scope.assertView();
      }
    }
    const batch = strictBatch ? activeBatches.get(context.signal) : undefined;
    if (strictBatch && !batch) throw pageHeld();
    const { ledger, group } = batch ?? {};
    if (group) assertBatch(group);
    const operation = scope.create({
      signal: context.signal,
      ...(group
        ? {
            assertDispatch: () => {
              try {
                assertBatch(group);
              } catch {
                throw new BrowserBackendConsumerError('superseded');
              }
            },
          }
        : {}),
    });
    operation.assertView();
    try {
      const result = await queryFn({ ...context, queryKey }, operation);
      operation.assertDeliveries();
      if (ledger && group) {
        const page = objectPage(result);
        if (!page) throw pageHeld();
        const proof = Object.freeze({ page, operation, parameter: context.pageParam, group: group.identity });
        ledger.pages.set(page, proof);
        group.proofs.add(proof);
      }
      return result;
    } catch (error) {
      if (group) {
        group.failure?.dispose();
        let originalError: (() => void) | undefined;
        try {
          if ('assertErrorDeliveries' in operation && typeof operation.assertErrorDeliveries === 'function') {
            const originalAssertion = operation.assertErrorDeliveries;
            originalError = () => {
              originalAssertion(error);
            };
            originalError();
          }
        } catch (causeFailure) {
          if (causeFailure instanceof BrowserBackendConsumerError && causeFailure.status === 'superseded')
            group.retired = true;
          originalError = undefined;
        }
        // The original failed attempt is checked when consumed. It is NOT a
        // permanent success dependency if an ordinary live retry replaces it.
        const observed = originalError ? error : pageHeld();
        group.failure = { error: observed, assertCurrent: originalError, dispose: operation.dispose };
        throw observed;
      }
      if (pageDelivery) operation.dispose();
      throw error;
    }
  };
  type BatchPersister = NonNullable<UseInfiniteQueryOptions<Result, Error, Selected, QueryKey, Param>['persister']>;
  const persistBatch = async (...batchArguments: Parameters<BatchPersister>): Promise<Result> => {
    const [fetchInfinite, context, query] = batchArguments;
    const actualQuery = client.getQueryCache().find({ queryKey: actualKey, exact: true });
    if (!actualQuery || actualQuery !== query) throw pageHeld();
    const ledger = ledgerFor(client, actualQuery);
    const group = pageGroup(ledger, actualQuery, context.signal);
    activeBatches.set(context.signal, { group, ledger });
    assertBatch(group);
    clearPageFailure(group);
    try {
      // Installed infiniteQueryBehavior supplies its real whole-batch fetchFn
      // through the per-page persister type. It ignores the argument; pass the
      // exact core context unchanged, with only this erased type restoration.
      const aggregate = (await Reflect.apply(fetchInfinite, undefined, [context])) as unknown as Result;
      if (
        aggregate === null ||
        typeof aggregate !== 'object' ||
        !('pages' in aggregate) ||
        !Array.isArray(aggregate.pages)
      )
        throw pageHeld();
      const retainedPages = new Set(aggregate.pages);
      const retained = [...group.proofs].filter((proof) => retainedPages.has(proof.page));
      // Cached prefix pages were already admitted input. Only NEW successful
      // pages actually retained by the real engine authorize this publication.
      assertBatch(group, retained);
      return aggregate;
    } catch (error) {
      assertBatch(group);
      const failure = readPageFailure(group);
      if (!failure || failure.error !== error) throw pageHeld();
      try {
        failure.assertCurrent?.();
      } catch (causeFailure) {
        if (causeFailure instanceof BrowserBackendConsumerError && causeFailure.status === 'superseded')
          group.retired = true;
        throw pageHeld();
      }
      throw error;
    } finally {
      clearPageFailure(group);
    }
  };
  const configured = {
    ...behavior,
    queryKey: actualKey,
    enabled: enabled && scope.isReady(),
    queryFn: wrappedQuery,
    ...(strictBatch ? { structuralSharing: false as const, persister: persistBatch as BatchPersister } : {}),
  };
  const result = useInfiniteQuery<Result, Error, Selected, QueryKey, Param>(configured);
  const capturePageSource = useCallback(() => {
    if (!pageDelivery || !enabled) throw pageHeld();
    return captureFixedPageSource(
      client,
      scope,
      configured as unknown as InfiniteQueryObserverOptions<
        Result,
        Error,
        InfiniteData<Result, Param>,
        QueryKey,
        Param
      >,
    );
  }, [client, scope, pageDelivery, enabled, configured]);
  return pageDelivery ? ({ ...result, capturePageSource } as HttpInfiniteQueryWithPages<Result, Error, Param>) : result;
}
