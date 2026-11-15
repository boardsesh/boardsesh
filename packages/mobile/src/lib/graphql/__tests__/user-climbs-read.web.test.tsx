// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

type Page = GetUserClimbsQueryResponse['userClimbs'];
const close: (() => void)[] = [];
beforeEach(() => vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0'));
afterEach(() => {
  cleanup();
  for (const dispose of close.splice(0).reverse()) dispose();
  selected.scope = null;
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
