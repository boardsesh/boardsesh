// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../http-query-scope';
import type { HttpInfinitePageSource } from '../use-http-query';
import type { GetUserClimbsQueryResponse } from '@boardsesh/graphql/operations';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing owned profile query scope');
    return selected.scope;
  },
}));
vi.mock('../client', () => ({
  getHttpClient: () => {
    throw new Error('Profile read used latest raw client');
  },
}));
vi.mock('../hooks/use-followed-authors', () => ({ useToggleAuthorFollow: vi.fn() }));
import { createScopedHttpFixture } from './fixtures/scoped-http';
import { useUserClimbs } from '../hooks/use-social';
import { httpPageSourceDiagnostics } from '../use-http-query';
import { createBrowserHttpOperations } from '../http-operation-client.web';
import { useHttpInfiniteQuery, isHttpPageHeld } from '../use-http-query';
import { ClientError, GraphQLClient } from 'graphql-request';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { createBrowserHttpClientFacade } from '../http-client-facade.web';
import { createHttpQueryScope } from '../http-query-scope';
import { __resetConnectivityStoreForTests, getConnectivitySnapshot } from '../../connectivity/connectivity-store';
import type { WebAuthIdentity } from '../../auth-store.web';

type Page = GetUserClimbsQueryResponse['userClimbs'];
const close: (() => void)[] = [];
beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
  __resetConnectivityStoreForTests();
  onlineManager.setOnline(true);
});
afterEach(() => {
  cleanup();
  for (const dispose of close.splice(0).reverse()) dispose();
  selected.scope = null;
  __resetConnectivityStoreForTests();
  onlineManager.setOnline(true);
  vi.unstubAllEnvs();
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const operations = createBrowserHttpOperations({
    captureScope: http.facade.captureRequestView,
    isCurrentView: http.facade.isCurrentView,
    captureResult: http.facade.captureResult,
    captureErrorDelivery: http.facade.captureErrorDelivery,
    resolveClient: (scope, mode) =>
      mode === 'offline' ? http.facade.getOfflineSyncHttpClient(scope) : http.facade.getHttpClient(scope),
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const requests: { userId: string; offset: number; limit: number }[] = [];
  http.performFetch.mockImplementation(async (_url, options) => {
    const body = JSON.parse((options as RequestInit).body as string) as {
      variables?: { input?: { userId: string; offset: number; limit: number } };
    };
    const input = body.variables?.input;
    if (input) requests.push(input);
    return Response.json({
      data: {
        userClimbs: {
          climbs: [{ uuid: `owned-${input?.offset ?? 'fresh'}`, name: 'Owned climb' }],
          hasMore: (input?.offset ?? 0) < 3,
        },
      },
    });
  });
  close.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, operations, cache, wrapper, requests };
}
function own(source: HttpInfinitePageSource<Page, number>) {
  close.push(() => source.dispose());
  return source;
}
function heldPage(offset: number, hasMore = true) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ data: { userClimbs: { climbs: [{ uuid: `held-${offset}` }], hasMore } } }),
          ),
        );
        release = () => controller.close();
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  return { response, release };
}

describe('actual SDK userClimbs and fixed page delivery', () => {
  it('keeps the viewed target distinct from the authenticating UID and preserves pagination', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(current.requests).toEqual([{ userId: 'public-target', offset: 0, limit: 30 }]);
    await act(() => result.current.fetchNextPage({ cancelRefetch: false }));
    expect(current.requests[1]).toEqual({ userId: 'public-target', offset: 1, limit: 30 });
    await waitFor(() =>
      expect(result.current.data!.pages.map((page) => page.climbs[0].uuid)).toEqual(['owned-0', 'owned-1']),
    );
  });

  it('captures passively and qualifies only the exact new page under its original successful operation', async () => {
    const current = fixture();
    current.cache.setQueryData(['userClimbs', 'public-target'], {
      pages: [{ climbs: [{ uuid: 'raw-A-private' }], hasMore: true }],
      pageParams: [0],
    });
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.pages[0].climbs[0].uuid).toBe('owned-0');
    const source = own(result.current.capturePageSource());
    expect(current.performFetch).toHaveBeenCalledOnce();
    const initial = source.read().data.pages[0];
    const delivered = await source.fetchNextPage();
    expect(delivered.status).toBe('delivered');
    if (delivered.status !== 'delivered') throw new Error('Expected actual page delivery');
    expect(delivered.data.pages[0]).toBe(initial);
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(delivered.data.pages[1]).toBe(result.current.data!.pages[1]);
    expect(() => delivered.assertCurrent()).not.toThrow();
    const second = delivered.consumer.retain();
    delivered.consumer.release();
    expect(() => second.assertCurrent()).not.toThrow();
    second.acknowledge();
    second.release();
    expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'public-target']))).toEqual({
      pendingGroups: 0,
      consumers: 0,
    });
  });

  it.each(['B', 'ABA', 'expiry-with-fresh-lease'] as const)('holds an actual next page across %s', async (change) => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const source = own(result.current.capturePageSource());
    const original = source.read().data;
    const held = heldPage(1);
    current.performFetch.mockResolvedValueOnce(held.response);
    const pending = source.fetchNextPage();
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    if (change === 'expiry-with-fresh-lease') {
      current.clock(200_000);
      const fresh = current.operations.capture({ mode: 'offline' });
      await fresh.request('query FreshOwned { freshOwned }');
      expect(() => fresh.assertDeliveries()).not.toThrow();
      fresh.dispose();
    } else {
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
    }
    held.release();
    expect(await pending).toEqual({ status: 'held', reason: 'retired' });
    // No old decoded page advanced the source before refusing.
    if (change === 'expiry-with-fresh-lease') expect(source.read().data).toBe(original);
    else expect(() => source.read()).toThrow();
  });

  it('keeps original terminal success provenance after both consumer releases, then refuses its expired lease', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const source = own(result.current.capturePageSource());
    current.performFetch.mockResolvedValueOnce(
      Response.json({ data: { userClimbs: { climbs: [{ uuid: 'terminal' }], hasMore: false } } }),
    );
    const delivered = await source.fetchNextPage();
    if (delivered.status !== 'delivered') throw new Error('Expected actual terminal delivery');
    const second = delivered.consumer.retain();
    delivered.consumer.release();
    second.release();
    expect(delivered.hasMore).toBe(false);
    expect(() => delivered.assertCurrent()).not.toThrow();
    expect(() => delivered.assertCurrent()).not.toThrow();
    current.clock(200_000);
    const fresh = current.operations.capture({ mode: 'offline' });
    await fresh.request('query FreshOwned { freshOwned }');
    expect(() => fresh.assertDeliveries()).not.toThrow();
    expect(() => delivered.assertCurrent()).toThrow();
    fresh.dispose();
  });

  it('joins a real multi-page refetch as no-progress without adopting its replacement prefix', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(() => result.current.fetchNextPage({ cancelRefetch: false }));
    const source = own(result.current.capturePageSource());
    const original = source.read().data;
    const held = heldPage(0);
    current.performFetch.mockResolvedValueOnce(held.response);
    let refetch!: ReturnType<typeof result.current.refetch>;
    act(() => {
      refetch = result.current.refetch({ cancelRefetch: false });
    });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
    const joined = source.fetchNextPage();
    held.release();
    await act(() => refetch);
    expect(await joined).toEqual({ status: 'no-progress', reason: 'joined-refetch' });
    expect(source.read().data).toBe(original);
    expect(source.read().data.pages[0].climbs[0].uuid).toBe('owned-0');
    const delivered = await source.fetchNextPage();
    expect(delivered.status).toBe('delivered');
    if (delivered.status === 'delivered') {
      expect(delivered.data.pages[2].climbs[0].uuid).toBe('owned-2');
      delivered.consumer.release();
    }
  });

  it('holds a changed cumulative offset before dispatch instead of skipping a page', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const source = own(result.current.capturePageSource());
    const original = source.read().data;
    current.performFetch.mockResolvedValueOnce(
      Response.json({
        data: { userClimbs: { climbs: [{ uuid: 'replacement-one' }, { uuid: 'replacement-two' }], hasMore: true } },
      }),
    );
    await act(() => result.current.refetch());
    const before = current.performFetch.mock.calls.length;
    expect(await source.fetchNextPage()).toEqual({ status: 'held', reason: 'offset-basis-changed' });
    expect(current.performFetch).toHaveBeenCalledTimes(before);
    expect(source.read().data).toBe(original);
  });

  it('keeps its fixed target after the originating observer changes target and unmounts', async () => {
    const current = fixture();
    const screen = renderHook(({ target }) => useUserClimbs(target), {
      initialProps: { target: 'target-A' },
      wrapper: current.wrapper,
    });
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    const source = own(screen.result.current.capturePageSource());
    screen.rerender({ target: 'target-B' });
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    screen.unmount();
    const delivered = await source.fetchNextPage();
    expect(current.requests.at(-1)).toMatchObject({ userId: 'target-A', offset: 1 });
    expect(delivered.status).toBe('delivered');
    if (delivered.status === 'delivered') delivered.consumer.release();
  });
  it.each(['same-UID-new-SID', 'same-UID-new-version'] as const)(
    'holds the original page across %s',
    async (change) => {
      const current = fixture();
      const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const source = own(result.current.capturePageSource());
      const held = heldPage(1);
      current.performFetch.mockResolvedValueOnce(held.response);
      const pending = source.fetchNextPage();
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      current.backend.acceptSession({
        user: { id: 'owned-A' },
        authSessionId: change === 'same-UID-new-SID' ? 'owned-SID-NEW' : 'owned-SID-A',
        authGeneration: 1,
        expires: '2099-01-01T00:00:00.000Z',
        browserSelection: {
          userId: 'owned-A',
          authSessionId: change === 'same-UID-new-SID' ? 'owned-SID-NEW' : 'owned-SID-A',
          generation: 1,
          cursor: { bindingId: 'a'.repeat(64), version: change === 'same-UID-new-version' ? 3 : 2 },
        },
      });
      held.release();
      expect(await pending).toEqual({ status: 'held', reason: 'retired' });
    },
  );

  it('keeps anonymous public pages lease-free through the same actual SDK source', async () => {
    const current = fixture();
    current.confirmAnonymous();
    selected.scope = current.scope();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const source = own(result.current.capturePageSource());
    const delivered = await source.fetchNextPage();
    expect(delivered.status).toBe('delivered');
    if (delivered.status === 'delivered') delivered.consumer.release();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.requests).toEqual([
      { userId: 'public-target', offset: 0, limit: 30 },
      { userId: 'public-target', offset: 1, limit: 30 },
    ]);
  });

  it('refuses a copied exact-offset page substituted by an actual QueryCache subscriber', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const source = own(result.current.capturePageSource());
    const original = source.read().data;
    const key = selected.scope!.key(['userClimbs', 'public-target']);
    let substituted = false;
    const stop = current.cache.getQueryCache().subscribe((event) => {
      const snapshot = event.query.state.data as { pages: Page[]; pageParams: number[] } | undefined;
      if (event.type !== 'updated' || event.action.type !== 'success' || substituted || snapshot?.pages.length !== 2)
        return;
      substituted = true;
      current.cache.setQueryData(key, { ...snapshot, pages: [snapshot.pages[0], { ...snapshot.pages[1] }] });
    });
    try {
      expect(await source.fetchNextPage()).toEqual({ status: 'no-progress', reason: 'joined-refetch' });
      expect(substituted).toBe(true);
      expect(source.read().data).toBe(original);
      expect(await source.fetchNextPage()).toEqual({ status: 'held', reason: 'offset-basis-changed' });
      expect(source.read().data).toBe(original);
      expect(current.performFetch).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
  it('joins the actual UI next-page request by its original signal/group rather than observer promises', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const source = own(result.current.capturePageSource());
    const held = heldPage(1);
    current.performFetch.mockResolvedValueOnce(held.response);
    let uiPending!: ReturnType<typeof result.current.fetchNextPage>;
    act(() => {
      uiPending = result.current.fetchNextPage({ cancelRefetch: false });
    });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    const fixedPending = source.fetchNextPage();
    held.release();
    await act(async () => {
      await uiPending;
    });
    const delivered = await fixedPending;
    expect(delivered.status).toBe('delivered');
    if (delivered.status !== 'delivered') throw new Error('Expected exact joined SDK page');
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(delivered.data.pages[1]).toBe(result.current.data!.pages[1]);
    delivered.consumer.release();
    expect(current.performFetch).toHaveBeenCalledTimes(2);
  });

  it('disposes one fixed source waiter while another same-query source retains the actual shared request', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const first = own(result.current.capturePageSource());
    const second = own(result.current.capturePageSource());
    const held = heldPage(1);
    current.performFetch.mockResolvedValueOnce(held.response);
    const firstPending = first.fetchNextPage();
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    const secondPending = second.fetchNextPage();
    first.dispose();
    const signal = (current.performFetch.mock.calls[1][1] as RequestInit).signal;
    expect(signal?.aborted).toBe(false);
    expect(await firstPending).toEqual({ status: 'held', reason: 'retired' });
    held.release();
    const delivered = await secondPending;
    expect(delivered.status).toBe('delivered');
    if (delivered.status === 'delivered') delivered.consumer.release();
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(httpPageSourceDiagnostics(current.cache, selected.scope!.key(['userClimbs', 'public-target']))).toEqual({
      pendingGroups: 0,
      consumers: 0,
    });
  });

  it('refuses an exact page object from another actual QueryClient ledger', async () => {
    const current = fixture();
    const first = renderHook(() => useUserClimbs('public-target'), { wrapper: current.wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const source = own(first.result.current.capturePageSource());
    const original = source.read().data;
    const otherCache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    close.push(() => otherCache.clear());
    const otherWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={otherCache}>{children}</QueryClientProvider>
    );
    const second = renderHook(() => useUserClimbs('public-target'), { wrapper: otherWrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    await act(() => second.result.current.fetchNextPage({ cancelRefetch: false }));
    await waitFor(() => expect(second.result.current.data!.pages).toHaveLength(2));
    const foreignPage = second.result.current.data!.pages[1];
    const key = selected.scope!.key(['userClimbs', 'public-target']);
    let substituted = false;
    const stop = current.cache.getQueryCache().subscribe((event) => {
      const snapshot = event.query.state.data as { pages: Page[]; pageParams: number[] } | undefined;
      if (event.type !== 'updated' || event.action.type !== 'success' || substituted || snapshot?.pages.length !== 2)
        return;
      substituted = true;
      current.cache.setQueryData(key, { ...snapshot, pages: [snapshot.pages[0], foreignPage] });
    });
    try {
      expect(await source.fetchNextPage()).toEqual({ status: 'no-progress', reason: 'joined-refetch' });
      expect(substituted).toBe(true);
      expect(source.read().data).toBe(original);
      expect(second.result.current.data!.pages[1]).toBe(foreignPage);
      const otherSource = own(second.result.current.capturePageSource());
      const delivered = await otherSource.fetchNextPage();
      expect(delivered.status).toBe('delivered');
      if (delivered.status === 'delivered') delivered.consumer.release();
      expect(source.read().data).toBe(original);
      expect(current.performFetch).toHaveBeenCalledTimes(5);
    } finally {
      stop();
    }
  });
});

/** Scheduling only: both actual operations, SDK invocations, signals and
 * receipts stay original. The second SDK request has not run when held. */
describe('actual infinite aggregate original causes', () => {
  it.each(['current', 'expired-first-page'] as const)(
    'checks a completed E1 page again before a real E2 aggregate publishes: %s',
    async (phase) => {
      const current = fixture();
      current.cache.setDefaultOptions({ queries: { retry: 2, retryDelay: 0 } });
      const originalScope = selected.scope!;
      const secondBody = heldPage(1);
      let refetching = false;
      let heldOnce = false;
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        resume = resolve;
      });
      selected.scope = Object.freeze({
        ...originalScope,
        create(options) {
          const original = originalScope.create(options);
          const request = new Proxy(original.request, {
            apply(target, receiver, parameters: unknown[]) {
              const variables = parameters[1];
              const input =
                variables && typeof variables === 'object' && 'input' in variables ? variables.input : undefined;
              const offset = input && typeof input === 'object' && 'offset' in input ? input.offset : undefined;
              if (refetching && offset === 1 && !heldOnce) {
                heldOnce = true;
                enter();
                return hold.then(() => Reflect.apply(target, receiver, parameters));
              }
              return Reflect.apply(target, receiver, parameters);
            },
          });
          return Object.freeze({ ...original, request });
        },
      });
      current.performFetch.mockImplementation(async (_url, init) => {
        const packet = JSON.parse((init as RequestInit).body as string) as {
          variables?: { input?: { offset: number } };
        };
        const offset = packet.variables?.input?.offset;
        if (refetching && offset === 1) return secondBody.response;
        return Response.json({
          data:
            offset === undefined
              ? { freshOwned: true }
              : { userClimbs: { climbs: [{ uuid: `${refetching ? 'new' : 'old'}-${offset}` }], hasMore: offset < 2 } },
        });
      });
      const screen = renderHook(() => useUserClimbs('aggregate-target'), { wrapper: current.wrapper });
      await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
      await act(() => screen.result.current.fetchNextPage({ cancelRefetch: false }));
      await waitFor(() => expect(screen.result.current.data?.pages).toHaveLength(2));
      const key = originalScope.key(['userClimbs', 'aggregate-target']);
      const before = current.cache.getQueryData(key);
      expect(screen.result.current.data?.pages.map((page) => page.climbs[0].uuid)).toEqual(['old-0', 'old-1']);
      current.clock(10_000);
      refetching = true;
      let pending!: ReturnType<typeof screen.result.current.refetch>;
      act(() => {
        pending = screen.result.current.refetch({ cancelRefetch: false });
      });
      await entered;
      // Page0 actually decoded/admitted E1; page1 has made NO SDK packet yet.
      expect(current.performFetch).toHaveBeenCalledTimes(3);
      current.clock(90_000);
      const fresh = current.operations.capture({ mode: 'offline' });
      await fresh.request('query FreshOwned { freshOwned }');
      fresh.assertDeliveries();
      expect(current.issueLease).toHaveBeenCalledTimes(2);
      fresh.dispose();
      current.clock(110_000);
      await act(async () => {
        resume();
      });
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(5));
      // The E2 packet has really dispatched while E1 remains live. Only its
      // response body is held now, so a pre-dispatch veto cannot mask this case.
      expect(current.cache.getQueryData(key)).toBe(before);
      current.clock(phase === 'current' ? 110_000 : 120_001);
      await act(async () => {
        secondBody.release();
        await pending;
      });
      expect(current.performFetch).toHaveBeenCalledTimes(5);
      expect(current.issueLease).toHaveBeenCalledTimes(2);
      const settled = current.cache.getQueryState<{ pages: Page[] }>(key);
      console.log('owned aggregate phase', {
        phase,
        packets: current.performFetch.mock.calls.length,
        leases: current.issueLease.mock.calls.length,
        status: settled?.status,
        fetchStatus: settled?.fetchStatus,
        rows: settled?.data?.pages.map((page) => page.climbs[0].uuid),
      });
      if (phase === 'current') {
        await waitFor(() =>
          expect(screen.result.current.data?.pages.map((page) => page.climbs[0].uuid)).toEqual(['new-0', 'held-1']),
        );
        expect(screen.result.current.isSuccess).toBe(true);
      } else {
        // Prior cache bytes stay input; no new aggregate may spend expired E1.
        expect(current.cache.getQueryData(key)).toBe(before);
        await waitFor(() => expect(screen.result.current.isError).toBe(true));
      }
    },
  );
});

describe('actual original cursor dispatch', () => {
  it.each(['current', 'expired-cursor-cause'] as const)(
    'checks the original cursor cause again after actual next-page acquisition: %s',
    async (phase) => {
      const current = fixture();
      let refetching = false;
      let acquisitions = 0;
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const acquire = current.backend.acquireScope.bind(current.backend);
      vi.spyOn(current.backend, 'acquireScope').mockImplementation(async (scope) => {
        if (refetching && ++acquisitions === 2) {
          enter();
          await hold;
        }
        return acquire(scope);
      });
      current.performFetch.mockImplementation(async (_url, init) => {
        const packet = JSON.parse((init as RequestInit).body as string) as {
          variables?: { input?: { offset: number } };
        };
        const offset = packet.variables?.input?.offset;
        return Response.json({
          data:
            offset === undefined
              ? { freshOwned: true }
              : {
                  userClimbs: {
                    climbs: [{ uuid: `${refetching ? 'fresh' : 'prior'}-${offset}` }],
                    hasMore: offset < 2,
                  },
                },
        });
      });
      const screen = renderHook(() => useUserClimbs('cursor-target'), { wrapper: current.wrapper });
      await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
      await act(() => screen.result.current.fetchNextPage({ cancelRefetch: false }));
      await waitFor(() => expect(screen.result.current.data?.pages).toHaveLength(2));
      const key = selected.scope!.key(['userClimbs', 'cursor-target']);
      const before = current.cache.getQueryData(key);
      current.clock(10_000);
      refetching = true;
      let pending!: ReturnType<typeof screen.result.current.refetch>;
      act(() => {
        pending = screen.result.current.refetch({ cancelRefetch: false });
      });
      await entered;
      expect(current.performFetch).toHaveBeenCalledTimes(3);
      current.clock(90_000);
      const fresh = current.operations.capture({ mode: 'offline' });
      await fresh.request('query FreshOwned { freshOwned }');
      fresh.assertDeliveries();
      fresh.dispose();
      expect(current.issueLease).toHaveBeenCalledTimes(2);
      current.clock(phase === 'current' ? 110_000 : 120_001);
      await act(async () => {
        resume();
        await pending;
      });
      if (phase === 'current') {
        await waitFor(() =>
          expect(screen.result.current.data?.pages.map((page) => page.climbs[0].uuid)).toEqual(['fresh-0', 'fresh-1']),
        );
        expect(current.performFetch).toHaveBeenCalledTimes(5);
      } else {
        await waitFor(() => expect(screen.result.current.isError).toBe(true));
        expect(current.cache.getQueryData(key)).toBe(before);
        // Actual acquire resumes with E2, but the E1 cursor cause cannot send.
        expect(current.performFetch).toHaveBeenCalledTimes(4);
        // A later independent group may retry under the still-current view.
        expect(getConnectivitySnapshot().effectiveOffline).toBe(false);
        await act(() => screen.result.current.refetch({ cancelRefetch: false }));
        await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
        expect(current.performFetch).toHaveBeenCalledTimes(6);
      }
    },
  );
});

type BatchPage = { items: string[]; next: boolean };
function useOwnedBatch(
  name: string,
  policy: {
    retry?: number;
    retryDelay?: (failure: number, error: unknown) => number;
    observeError?: (error: unknown) => unknown;
  } = {},
) {
  return useHttpInfiniteQuery({
    pageDelivery: true,
    queryKey: ['ownedBatch', name] as const,
    initialPageParam: 0,
    retry: policy.retry ?? false,
    retryDelay: policy.retryDelay,
    queryFn: async ({ pageParam }, operation) => {
      try {
        const response = await operation.request<{ batch: BatchPage }>(
          'query OwnedBatch($offset: Int!) { batch(offset: $offset) { items next } }',
          { offset: pageParam },
        );
        return response.batch;
      } catch (error) {
        throw policy.observeError ? await policy.observeError(error) : error;
      }
    },
    getNextPageParam: (last, _pages, offset) => (last.next ? offset + 1 : undefined),
  });
}

describe('original batch errors, retries and admitted cached prefix', () => {
  it('keeps an admitted cached prefix after E1 expiry while a new E2 page has its own proof', async () => {
    const current = fixture();
    const screen = renderHook(() => useUserClimbs('cached-prefix'), { wrapper: current.wrapper });
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    const prefix = screen.result.current.data!.pages[0];
    const source = own(screen.result.current.capturePageSource());
    current.clock(200_000);
    const delivered = await source.fetchNextPage();
    expect(delivered.status).toBe('delivered');
    if (delivered.status !== 'delivered') throw new Error('Expected actual new E2 page');
    expect(delivered.data.pages[0]).toBe(prefix);
    expect(delivered.data.pages[1].climbs[0].uuid).toBe('owned-1');
    expect(current.issueLease).toHaveBeenCalledTimes(2);
    delivered.consumer.acknowledge();
    delivered.consumer.release();
    current.clock(400_000);
    // ACKed rows are input, not a permanent claim of their old network lease.
    expect(source.read().data.pages).toEqual(delivered.data.pages);
  });

  it('retries an authentic SDK E1 error successfully with E2 after the failed lease expires', async () => {
    const current = fixture();
    const errors: unknown[] = [];
    current.performFetch
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Owned transient error' }] }))
      .mockResolvedValueOnce(Response.json({ data: { batch: { items: ['retry-E2'], next: false } } }));
    const screen = renderHook(
      () =>
        useOwnedBatch('retry-error', {
          retry: 1,
          retryDelay: () => {
            current.clock(200_000);
            return 0;
          },
          observeError: (error) => {
            errors.push(error);
            return error;
          },
        }),
      { wrapper: current.wrapper },
    );
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ClientError);
    expect(screen.result.current.data?.pages).toEqual([{ items: ['retry-E2'], next: false }]);
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(current.issueLease).toHaveBeenCalledTimes(2);
  });

  it.each(['original', 'copied', 'unknown', 'expired'] as const)(
    'publishes only the exact original live SDK error: %s',
    async (kind) => {
      const current = fixture();
      let original: unknown;
      if (kind === 'unknown') current.performFetch.mockRejectedValueOnce(new Error('Owned fetch failure'));
      else
        current.performFetch.mockResolvedValueOnce(
          Response.json({
            data: { batch: { items: ['partial-private'], next: false } },
            errors: [{ message: 'Owned authentic refusal' }],
          }),
        );
      const screen = renderHook(
        () =>
          useOwnedBatch(`error-${kind}`, {
            observeError: (error) => {
              original = error;
              if (kind === 'expired') current.clock(200_000);
              if (kind === 'copied' && error instanceof ClientError)
                return new ClientError({ ...error.response }, error.request);
              return error;
            },
          }),
        { wrapper: current.wrapper },
      );
      await waitFor(() => expect(screen.result.current.isError).toBe(true));
      expect(current.performFetch).toHaveBeenCalledOnce();
      expect(screen.result.current.data).toBeUndefined();
      expect(current.cache.getQueryData(selected.scope!.key(['ownedBatch', `error-${kind}`]))).toBeUndefined();
      if (kind === 'original') {
        expect(original).toBeInstanceOf(ClientError);
        expect(screen.result.current.error).toBe(original);
        expect(isHttpPageHeld(screen.result.current.error)).toBe(false);
      } else {
        expect(screen.result.current.error).not.toBe(original);
        expect(isHttpPageHeld(screen.result.current.error)).toBe(true);
      }
    },
  );

  it.each(['before-first-assert', 'between-original-asserts'] as const)(
    'makes confirmed original error retirement terminal across retry: %s',
    async (stage) => {
      const current = fixture();
      const originalScope = selected.scope!;
      if (stage === 'between-original-asserts') {
        selected.scope = Object.freeze({
          ...originalScope,
          create(options) {
            const operation = originalScope.create(options);
            if (!('assertErrorDeliveries' in operation) || typeof operation.assertErrorDeliveries !== 'function')
              throw new Error('Actual full error assertion is missing');
            const assertion = operation.assertErrorDeliveries;
            return Object.freeze({
              ...operation,
              assertErrorDeliveries(error: unknown) {
                assertion(error);
                queueMicrotask(() => current.clock(120_001));
              },
            });
          },
        });
      }
      let original: unknown;
      current.performFetch
        .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Admitted E1 rejection' }] }))
        .mockImplementation(async () =>
          Response.json({ data: { freshOwned: true, batch: { items: ['forbidden-retry'], next: false } } }),
        );
      const screen = renderHook(
        () =>
          useOwnedBatch(`retired-error-${stage}`, {
            retry: 2,
            retryDelay: () => 0,
            observeError: async (error) => {
              original = error;
              current.clock(90_000);
              const fresh = current.operations.capture({ mode: 'offline' });
              await fresh.request('query FreshOwned { freshOwned }');
              fresh.assertDeliveries();
              fresh.dispose();
              current.clock(stage === 'before-first-assert' ? 120_001 : 110_000);
              return error;
            },
          }),
        { wrapper: current.wrapper },
      );
      await waitFor(() => expect(screen.result.current.isError).toBe(true));
      expect(original).toBeInstanceOf(ClientError);
      expect(isHttpPageHeld(screen.result.current.error)).toBe(true);
      expect(screen.result.current.data).toBeUndefined();
      expect(current.issueLease).toHaveBeenCalledTimes(2);
      // One actual failed batch packet and one independent fresh E2 proof.
      expect(current.performFetch).toHaveBeenCalledTimes(2);
      expect(
        current.cache.getQueryState(selected.scope!.key(['ownedBatch', `retired-error-${stage}`]))?.fetchFailureCount,
      ).toBe(3);
    },
  );

  it('can replace an unknown transient failure with a genuine current SDK success', async () => {
    const current = fixture();
    current.performFetch
      .mockRejectedValueOnce(new Error('Owned temporary fetch failure'))
      .mockResolvedValueOnce(Response.json({ data: { batch: { items: ['recovered'], next: false } } }));
    const screen = renderHook(
      () =>
        useOwnedBatch('unknown-retry', {
          retry: 1,
          retryDelay: () => {
            __resetConnectivityStoreForTests();
            onlineManager.setOnline(true);
            return 0;
          },
        }),
      { wrapper: current.wrapper },
    );
    await waitFor(() => expect(screen.result.current.isSuccess).toBe(true));
    expect(screen.result.current.data?.pages).toEqual([{ items: ['recovered'], next: false }]);
    expect(current.performFetch).toHaveBeenCalledTimes(2);
  });
});

function legacyFixture() {
  const owner = {
    userId: 'selected-B',
    authSessionId: 'selected-SID',
    generation: 1,
    cursor: { bindingId: 'b'.repeat(64), version: 2 },
  };
  let identity: WebAuthIdentity = { userId: 'legacy-A', authSessionId: 'legacy-SID' };
  const issueLease = vi.fn(async () =>
    Response.json({ status: 'admitted', token: 'bsbd1_OWNED_LEGACY_TRANSITION', usableForMs: 120_000, owner }),
  );
  const backend = createBrowserBackendClient({
    ready: () => true,
    endpoint: '/owned-legacy-lease',
    now: () => 0,
    fetch: issueLease,
    schedule: () => () => {},
  });
  const performFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({ data: { batch: { items: ['legacy-admitted'], next: false } } }),
  );
  const rawClient = new GraphQLClient('https://backend.owned.test/graphql', { fetch: performFetch });
  const facade = createBrowserHttpClientFacade({
    backendClient: backend,
    captureGeneration: () => 0,
    isGenerationCurrent: (generation) => generation === 0,
    captureIdentity: () => identity,
    confirmedAnonymous: () => false,
    required: () => false,
    namespace: () => 'owned_legacy_infinite',
    url: 'https://backend.owned.test/graphql',
    fetch: performFetch,
    legacyFetch: performFetch,
    timeoutMs: () => 20_000,
    clientIdentity: () => 'owned-legacy-infinite',
    legacy: { get: () => rawClient, reset: () => {} },
  });
  const operations = createBrowserHttpOperations({
    captureScope: facade.captureRequestView,
    isCurrentView: facade.isCurrentView,
    captureResult: facade.captureResult,
    captureErrorDelivery: facade.captureErrorDelivery,
    resolveClient: (scope) => facade.getHttpClient(scope),
  });
  const scope = facade.captureRequestView();
  selected.scope = createHttpQueryScope({
    scope,
    scoped: false,
    prefix: [],
    isCurrentView: facade.isCurrentView,
    createOperation: (options) => operations.create(scope, options),
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const selectB = () => {
    identity = { userId: owner.userId, authSessionId: owner.authSessionId, browserSelection: owner };
    backend.acceptSession({
      user: { id: owner.userId },
      authSessionId: owner.authSessionId,
      authGeneration: owner.generation,
      expires: '2099-01-01T00:00:00Z',
      browserSelection: owner,
    });
  };
  close.push(() => {
    cache.clear();
    facade.dispose();
    backend.dispose();
  });
  return { cache, facade, performFetch, wrapper, selectB, issueLease };
}
function useLegacyBatch(current: ReturnType<typeof legacyFixture>, started: () => void = () => {}) {
  return useHttpInfiniteQuery({
    pageDelivery: true,
    queryKey: ['ownedLegacyBatch'],
    initialPageParam: 0,
    queryFn: async () => {
      throw new Error('Legacy executor must stay original');
    },
    nativeQueryFn: async (context) => {
      started();
      const response = await current.facade
        .getHttpClient()
        .request<{ batch: BatchPage }>(
          'query OwnedLegacyBatch($offset: Int!) { batch(offset: $offset) { items next } }',
          { offset: context.pageParam },
        );
      return response.batch;
    },
    getNextPageParam: () => undefined,
  });
}

describe('actual whollylegacy original executor', () => {
  it('finishes its actual untouched-context SDK work after observer deletion', async () => {
    const current = legacyFixture();
    let release!: () => void;
    const body = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ data: { batch: { items: ['legacy-after-unmount'], next: false } } }),
            ),
          );
          release = () => controller.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    current.performFetch.mockResolvedValueOnce(body);
    const screen = renderHook(() => useLegacyBatch(current), { wrapper: current.wrapper });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    const pending = current.cache.getQueryCache().getAll()[0].promise;
    screen.unmount();
    await act(async () => {
      release();
      await pending;
    });
    expect(current.cache.getQueryData(['ownedLegacyBatch'])).toEqual({
      pages: [{ items: ['legacy-after-unmount'], next: false }],
      pageParams: [0],
    });
    expect(current.issueLease).not.toHaveBeenCalled();
  });

  it('refuses a paused legacy executor before it can adopt selected B', async () => {
    const current = legacyFixture();
    onlineManager.setOnline(false);
    const entered = vi.fn();
    const screen = renderHook(() => useLegacyBatch(current, entered), { wrapper: current.wrapper });
    await waitFor(() => expect(screen.result.current.fetchStatus).toBe('paused'));
    expect(entered).not.toHaveBeenCalled();
    current.selectB();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(entered).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.cache.getQueryData(['ownedLegacyBatch'])).toBeUndefined();
  });

  it('refuses late legacy body publication after selected B replaces its original view', async () => {
    const current = legacyFixture();
    let release!: () => void;
    const body = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ data: { batch: { items: ['late-private-A'], next: false } } })),
          );
          release = () => controller.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    current.performFetch.mockResolvedValueOnce(body);
    const screen = renderHook(() => useLegacyBatch(current), { wrapper: current.wrapper });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    current.selectB();
    await act(async () => release());
    await waitFor(() => expect(screen.result.current.isError).toBe(true));
    expect(current.performFetch).toHaveBeenCalledOnce();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.cache.getQueryData(['ownedLegacyBatch'])).toBeUndefined();
  });
});
