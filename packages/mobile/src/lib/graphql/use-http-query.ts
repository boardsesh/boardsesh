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
  group: object;
  parameter: unknown;
  operation: HttpQueryOperation;
}>;
type PageGroup = {
  identity: object;
  promise: Promise<unknown>;
  proofs: Set<PageProof>;
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
  const group: PageGroup = { identity: Object.freeze({}), promise, proofs: new Set() };
  ledger.pending.set(signal, group);
  const settled = (failed: boolean) => {
    if (ledger.pending.get(signal) === group) ledger.pending.delete(signal);
    if (failed) for (const proof of group.proofs) proof.operation.dispose();
    group.proofs.clear();
  };
  void promise.then(
    () => settled(false),
    () => settled(true),
  );
  return group;
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
  const { queryFn, queryKey, enabled = true, pageDelivery = false, ...behavior } = options;
  const actualKey = scope.key(queryKey);
  const wrappedQuery = async (context: QueryFunctionContext<QueryKey, Param>) => {
    const operation = scope.create({ signal: context.signal });
    operation.assertView();
    const query = client.getQueryCache().find({ queryKey: actualKey, exact: true });
    const ledger = pageDelivery && scope.scoped && query ? ledgerFor(client, query) : undefined;
    const group = ledger && query ? pageGroup(ledger, query, context.signal) : undefined;
    try {
      const result = await queryFn({ ...context, queryKey }, operation);
      operation.assertDeliveries();
      if (ledger && group) {
        const page = objectPage(result);
        if (!page) throw pageHeld();
        const proof = Object.freeze({ operation, parameter: context.pageParam, group: group.identity });
        ledger.pages.set(page, proof);
        group.proofs.add(proof);
      }
      return result;
    } catch (error) {
      if (pageDelivery) operation.dispose();
      if (pageDelivery && scope.scoped && error instanceof BrowserBackendConsumerError) throw pageHeld();
      throw error;
    }
  };
  const configured = {
    ...behavior,
    queryKey: actualKey,
    enabled: enabled && scope.isReady(),
    queryFn: wrappedQuery,
    ...(pageDelivery && scope.scoped ? { structuralSharing: false as const } : {}),
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
