// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing owned query fixture');
    return selected.scope;
  },
}));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));

import { createScopedHttpFixture } from './fixtures/scoped-http';
import { useProfile, useUpdateProfile } from '../hooks/use-profile';
import { useIsAdmin } from '../hooks/use-is-admin';
import { useHttpMutation } from '../use-http-mutation';
import { useHttpInfiniteQuery } from '../use-http-query';

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  dispose.splice(0).forEach((close) => close());
  selected.scope = null;
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  dispose.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
}
function heldResponse(payload: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: payload })));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}

describe('actual scoped profile/admin and QueryClient mutation consumers', () => {
  it('keeps nullable profile and fail-closed admin reads available without a signed-in precondition', async () => {
    const current = fixture();
    current.confirmAnonymous();
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async () => Response.json({ data: { profile: null } }));
    const { result } = renderHook(() => ({ profile: useProfile(), admin: useIsAdmin() }), current);
    await waitFor(() => expect(result.current.profile.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.admin.isLoading).toBe(false));
    expect(result.current.profile.data).toBeNull();
    expect(result.current.admin.isAdmin).toBe(false);
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    expect(current.issueLease).not.toHaveBeenCalled();
    for (const [, init] of current.performFetch.mock.calls)
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBeNull();
  });

  it.each(['B', 'ABA'] as const)('cannot fill the new %s profile key from a delayed A body', async (change) => {
    const current = fixture();
    const original = selected.scope!;
    const held = heldResponse({ profile: { id: 'owned-A', displayName: 'Old A' } });
    current.performFetch.mockResolvedValueOnce(held.response);
    const { result, rerender } = renderHook(() => useProfile(), current);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async () =>
      Response.json({ data: { profile: { id: change === 'B' ? 'owned-B' : 'owned-A', displayName: 'Fresh login' } } }),
    );
    rerender();
    await waitFor(() => expect(result.current.data?.displayName).toBe('Fresh login'));
    await act(async () => {
      held.release();
    });
    expect(result.current.data?.displayName).toBe('Fresh login');
    expect(current.cache.getQueryData(original.key(['profile']))).toBeUndefined();
    expect(current.cache.getQueryData(selected.scope.key(['profile']))).toEqual({
      profile: { id: change === 'B' ? 'owned-B' : 'owned-A', displayName: 'Fresh login' },
    });
  });

  it('does not enable a required query while its captured central view is unavailable', async () => {
    const current = fixture();
    const unavailable = selected.scope!;
    selected.scope = Object.freeze({ ...unavailable, isReady: () => false });
    const { result } = renderHook(() => useProfile(), current);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('passes actual infinite page parameters and original query keys through the adapter', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, init) => {
      const variables = JSON.parse((init as RequestInit).body as string).variables;
      return Response.json({ data: { page: { offset: variables.offset } } });
    });
    const originalKeys: unknown[] = [];
    const { result } = renderHook(
      () => ({
        ...useHttpInfiniteQuery({
          queryKey: ['owned-pages'] as const,
          initialPageParam: 0,
          queryFn: async ({ pageParam, queryKey }, operation) => {
            originalKeys.push(queryKey);
            const response = await operation.request<{ page: { offset: number } }>('{ page { offset } }', {
              offset: pageParam,
            });
            return response.page;
          },
          getNextPageParam: (lastPage) => (lastPage.offset === 0 ? 10 : undefined),
        }),
      }),
      current,
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      const next = await result.current.fetchNextPage();
      expect(next.error).toBeNull();
      expect(next.data?.pages).toEqual([{ offset: 0 }, { offset: 10 }]);
    });
    await waitFor(() => expect(result.current.data?.pages).toEqual([{ offset: 0 }, { offset: 10 }]));
    expect(originalKeys).toEqual([['owned-pages'], ['owned-pages']]);
    expect(current.cache.getQueryData(['owned-pages'])).toBeUndefined();
  });

  it('captures before held onMutate and refuses B without sending or running stale callbacks', async () => {
    const current = fixture();
    let release!: () => void;
    const entered = vi.fn();
    const success = vi.fn();
    const error = vi.fn();
    const { result } = renderHook(
      () =>
        useHttpMutation({
          onMutate: async () => {
            entered();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          },
          mutationFn: (_input: string, operation) => operation.request('{ viewer { id } }'),
          onSuccess: success,
          onError: error,
        }),
      current,
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync('original-A-input');
    });
    const refused = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    await waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    await act(async () => {
      release();
      await refused;
    });
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('writes profile success only into its original scoped caches and returns an exact delivery guard', async () => {
    const current = fixture();
    const original = selected.scope!;
    current.performFetch.mockResolvedValue(
      Response.json({ data: { updateProfile: { id: 'owned-A', displayName: 'New A', avatarUrl: null } } }),
    );
    current.cache.setQueryData(original.key(['publicProfile', 'owned-A']), { displayName: 'Old A' });
    const { result } = renderHook(() => useUpdateProfile(), current);
    const accepted = await result.current.mutateWithReceipt({ displayName: 'New A' });
    accepted.assertCurrent();
    expect(current.cache.getQueryData(original.key(['profile']))).toEqual({
      profile: { id: 'owned-A', displayName: 'New A', avatarUrl: null },
    });
    expect(current.cache.getQueryData(['profile'])).toBeUndefined();
    current.switchAccount('owned-B');
    expect(() => accepted.assertCurrent()).toThrow();
  });

  it('rechecks the original delivery after held cache refresh before invoking per-call success', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValue(
      Response.json({ data: { updateProfile: { id: 'owned-A', displayName: 'New A' } } }),
    );
    let release!: () => void;
    const refreshing = vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const success = vi.fn();
    const { result } = renderHook(() => useUpdateProfile(), current);
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ displayName: 'New A' }, { onSuccess: success });
    });
    const refused = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    await waitFor(() => expect(refreshing).toHaveBeenCalledTimes(1));
    current.switchAccount('owned-B');
    await act(async () => {
      release();
      await refused;
    });
    expect(success).not.toHaveBeenCalled();
  });

  it('retains invocation callbacks while same-view hook options change', async () => {
    const current = fixture();
    const held = heldResponse({ viewer: { id: 'owned-A' } });
    current.performFetch.mockResolvedValueOnce(held.response);
    const originalSuccess = vi.fn();
    const newerSuccess = vi.fn();
    const { result, rerender } = renderHook(
      ({ onSuccess }) =>
        useHttpMutation({
          mutationFn: (_input: string, operation) => operation.request('{ viewer { id } }'),
          onSuccess,
        }),
      { wrapper: current.wrapper, initialProps: { onSuccess: originalSuccess } },
    );
    const mutate = result.current.mutateAsync;
    let pending!: Promise<unknown>;
    act(() => {
      pending = mutate('input-A');
    });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    rerender({ onSuccess: newerSuccess });
    expect(result.current.mutateAsync).toBe(mutate);
    await act(async () => {
      held.release();
      await pending;
    });
    expect(originalSuccess).toHaveBeenCalledTimes(1);
    expect(newerSuccess).not.toHaveBeenCalled();
  });

  it('does not let a fresh same-owner mutation extend an earlier caller receipt', async () => {
    const current = fixture();
    const { result } = renderHook(
      () =>
        useHttpMutation({
          mutationFn: async (_input: void, operation) => {
            const response = await operation.request<{ viewer: { id: string } }>('{ viewer { id } }');
            return response.viewer.id;
          },
        }),
      current,
    );
    const first = await result.current.mutateWithReceipt();
    current.clock(90_000);
    const second = await result.current.mutateWithReceipt();
    expect(first.result).toBe('owned-A');
    current.clock(120_001);
    expect(() => first.assertCurrent()).toThrow();
    second.assertCurrent();
  });

  it('cancels a held abort-ignoring mutation body before callbacks or caller effects', async () => {
    const current = fixture();
    const held = heldResponse({ viewer: { id: 'owned-A' } });
    current.performFetch.mockResolvedValueOnce(held.response);
    const controller = new AbortController();
    const success = vi.fn();
    const { result } = renderHook(
      () =>
        useHttpMutation({
          signal: controller.signal,
          mutationFn: (_input: void, operation) => operation.request('{ viewer { id } }'),
          onSuccess: success,
        }),
      current,
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateWithReceipt();
    });
    const reason = new Error('Owned caller cancelled');
    const refused = expect(pending).rejects.toBe(reason);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    await act(async () => {
      held.release();
      await refused;
    });
    expect(success).not.toHaveBeenCalled();
    expect(current.performFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['hook', 'call'] as const)(
    'honors the %s signal when an invocation supplies both signals',
    async (cancel) => {
      const current = fixture();
      const held = heldResponse({ viewer: { id: 'owned-A' } });
      current.performFetch.mockResolvedValueOnce(held.response);
      const hook = new AbortController();
      const call = new AbortController();
      const success = vi.fn();
      const { result } = renderHook(
        () =>
          useHttpMutation({
            signal: hook.signal,
            mutationFn: (_input: void, operation) => operation.request('{ viewer { id } }'),
            onSuccess: success,
          }),
        current,
      );
      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.mutateWithReceipt(undefined, { signal: call.signal });
      });
      const reason = new Error(`Original ${cancel} cancelled`);
      const refused = expect(pending).rejects.toBe(reason);
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
      (cancel === 'hook' ? hook : call).abort(reason);
      await act(async () => {
        held.release();
        await refused;
      });
      expect(success).not.toHaveBeenCalled();
      expect(current.performFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses an already-cancelled per-call signal before onMutate or any packet', async () => {
    const current = fixture();
    const call = new AbortController();
    const onMutate = vi.fn();
    const { result } = renderHook(
      () =>
        useHttpMutation({
          onMutate,
          mutationFn: (_input: void, operation) => operation.request('{ viewer { id } }'),
        }),
      current,
    );
    const reason = new Error('Already cancelled action');
    call.abort(reason);
    await expect(result.current.mutateWithReceipt(undefined, { signal: call.signal })).rejects.toMatchObject({
      status: 'superseded',
    });
    expect(onMutate).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
  });
});
