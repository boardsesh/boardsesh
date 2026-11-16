// @vitest-environment jsdom
// Native requests keep their pre-account-view lifetime: a write the climber
// started and a read a screen started both finish after that screen goes. The
// account fences are the browser target's (scoped-query-callers.test.tsx).
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  request: vi.fn<(options: { document: unknown; variables?: unknown; signal: AbortSignal }) => Promise<unknown>>(),
}));
vi.mock('../client', () => ({
  getHttpClient: () => ({ request: transport.request }),
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected native offline I/O');
  },
}));
// The real auth store drives sign-in, sign-out and token refresh below; only
// its keychain is in memory.
vi.mock('expo-secure-store', () => {
  const storage = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK: 'after-first-unlock',
    getItemAsync: async (key: string) => storage.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      storage.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      storage.delete(key);
    },
  };
});

import { useHttpMutation } from '../use-http-mutation';
import { useHttpInfiniteQuery, useHttpQuery } from '../use-http-query';
import { useHttpActionScope } from '../use-http-action-scope';
import {
  captureAuthCredentialGeneration,
  clearTokensForGeneration,
  storeTokens,
  storeTokensForGeneration,
} from '../../auth-store';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
const sentSignal = (call = 0) => transport.request.mock.calls[call][0].signal;

beforeEach(() => transport.request.mockReset());
afterEach(cleanup);

describe('native writes outlive the screen that started them', () => {
  function useSave(client: QueryClient, events: string[]) {
    return {
      action: useHttpActionScope(),
      save: useHttpMutation({
        mutationFn: (name: string, operation) => operation.request('mutation { save }', { name }),
        onMutate: (name: string) => {
          const previous = client.getQueryData<string>(['profile-name']);
          client.setQueryData(['profile-name'], name);
          return previous;
        },
        onSuccess: () => {
          events.push('saved');
        },
        onError: (_error, _name, previous) => {
          events.push('rolled back');
          client.setQueryData(['profile-name'], previous);
        },
      }),
    };
  }

  it('sends and lands a save after the screen unmounts mid-request', async () => {
    const { client, wrapper } = harness();
    const response = deferred<unknown>();
    transport.request.mockReturnValueOnce(response.promise);
    const events: string[] = [];
    const view = renderHook(() => useSave(client, events), { wrapper });
    const action = view.result.current.action.capture();
    let saved!: Promise<unknown>;
    act(() => {
      saved = view.result.current.save.mutateWithReceipt('Alex', { signal: action.signal });
    });
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());

    view.unmount();
    // The screen's own follow-up (toast, navigation) is retired with it.
    expect(action.isCurrent()).toBe(false);
    expect(sentSignal().aborted).toBe(false);
    await act(async () => response.resolve({ save: true }));

    await expect(saved).resolves.toMatchObject({ result: { save: true } });
    expect(events).toEqual(['saved']);
    expect(client.getQueryData(['profile-name'])).toBe('Alex');
    client.clear();
  });

  it('rolls its optimistic write back when the save fails after the screen unmounts', async () => {
    const { client, wrapper } = harness();
    client.setQueryData(['profile-name'], 'Sam');
    const response = deferred<unknown>();
    transport.request.mockReturnValueOnce(response.promise);
    const events: string[] = [];
    const view = renderHook(() => useSave(client, events), { wrapper });
    const action = view.result.current.action.capture();
    let saved!: Promise<unknown>;
    act(() => {
      saved = view.result.current.save.mutateWithReceipt('Alex', { signal: action.signal });
    });
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());
    expect(client.getQueryData(['profile-name'])).toBe('Alex');

    view.unmount();
    const failure = new Error('Server refused');
    await act(async () => {
      response.reject(failure);
      await saved.catch(() => {});
    });

    await expect(saved).rejects.toBe(failure);
    expect(events).toEqual(['rolled back']);
    expect(client.getQueryData(['profile-name'])).toBe('Sam');
    client.clear();
  });

  it('starts nothing for an action its screen already retired', async () => {
    const { client, wrapper } = harness();
    const events: string[] = [];
    const view = renderHook(() => useSave(client, events), { wrapper });
    const caller = new AbortController();
    const reason = new Error('Retired action');
    caller.abort(reason);

    await expect(view.result.current.save.mutateWithReceipt('Alex', { signal: caller.signal })).rejects.toBe(reason);
    expect(transport.request).not.toHaveBeenCalled();
    expect(client.getQueryData(['profile-name'])).toBeUndefined();
    client.clear();
  });
});

describe('native reads finish into the cache', () => {
  it('keeps a query running after its screen unmounts', async () => {
    const { client, wrapper } = harness();
    const response = deferred<unknown>();
    transport.request.mockReturnValueOnce(response.promise);
    const view = renderHook(
      () =>
        useHttpQuery({
          queryKey: ['profile'],
          queryFn: (_context, operation) => operation.request<{ profile: string }>('{ profile }'),
        }),
      { wrapper },
    );
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());

    view.unmount();
    expect(sentSignal().aborted).toBe(false);
    await act(async () => response.resolve({ profile: 'Alex' }));

    await waitFor(() => expect(client.getQueryData(['profile'])).toEqual({ profile: 'Alex' }));
    client.clear();
  });

  it('keeps a page running after its screen unmounts', async () => {
    const { client, wrapper } = harness();
    const response = deferred<unknown>();
    transport.request.mockReturnValueOnce(response.promise);
    const view = renderHook(
      () =>
        useHttpInfiniteQuery({
          queryKey: ['followers', 'climber'],
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          queryFn: ({ pageParam }, operation) => operation.request<{ page: number }>('{ page }', { pageParam }),
        }),
      { wrapper },
    );
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());

    view.unmount();
    expect(sentSignal().aborted).toBe(false);
    await act(async () => response.resolve({ page: 0 }));

    await waitFor(() =>
      expect(client.getQueryData(['followers', 'climber'])).toEqual({ pages: [{ page: 0 }], pageParams: [0] }),
    );
    client.clear();
  });

  it('still hands a query function that reads its signal the real one, under its own key', async () => {
    const { client, wrapper } = harness();
    let seen: { signal: AbortSignal; queryKey: readonly unknown[] } | undefined;
    const view = renderHook(
      () =>
        useHttpQuery({
          queryKey: ['opted-in'] as const,
          queryFn: ({ signal, queryKey }) => {
            seen = { signal, queryKey };
            return new Promise<string>(() => {});
          },
        }),
      { wrapper },
    );
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen!.queryKey).toEqual(['opted-in']);

    view.unmount();
    expect(seen!.signal.aborted).toBe(true);
    client.clear();
  });
});

describe('native requests end with the account that started them', () => {
  // As the app signs out: the token clear retires the credential at once,
  // then the provider clears the cache.
  function signOut(client: QueryClient) {
    act(() => {
      void clearTokensForGeneration(captureAuthCredentialGeneration());
      client.clear();
    });
  }

  it('writes nothing from a read answered after sign-out clears the cache', async () => {
    const { client, wrapper } = harness();
    const response = deferred<{ groupedNotifications: { unreadCount: number } }>();
    transport.request.mockReturnValueOnce(response.promise);
    renderHook(
      () =>
        useHttpQuery({
          queryKey: ['groupedNotifications'],
          queryFn: async (_context, operation) => {
            const page = await operation.request<{ groupedNotifications: { unreadCount: number } }>('{ page }');
            // The bell badge rides along on the first page, as useGroupedNotifications does.
            operation.cache(client).setQueryData(['unreadCount'], page.groupedNotifications.unreadCount);
            return page;
          },
        }),
      { wrapper },
    );
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());

    signOut(client);
    await act(async () => response.resolve({ groupedNotifications: { unreadCount: 4 } }));
    await act(async () => {});

    expect(client.getQueryData(['unreadCount'])).toBeUndefined();
    expect(client.getQueryData(['groupedNotifications'])).toBeUndefined();
    client.clear();
  });

  it('runs none of a write’s callbacks when it is answered after sign-out', async () => {
    const { client, wrapper } = harness();
    const response = deferred<unknown>();
    transport.request.mockReturnValueOnce(response.promise);
    const events: string[] = [];
    const view = renderHook(
      () =>
        useHttpMutation({
          mutationFn: (_input: void, operation) => operation.request('mutation { vote }'),
          onSuccess: () => {
            events.push('saved');
            client.setQueryData(['bulkVoteSummaries'], ['old account']);
          },
          onError: () => {
            events.push('rolled back');
          },
        }),
      { wrapper },
    );
    let saved!: Promise<unknown>;
    act(() => {
      saved = view.result.current.mutateWithReceipt();
    });
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());

    signOut(client);
    await act(async () => {
      response.resolve({ vote: true });
      await saved.catch(() => {});
    });

    await expect(saved).rejects.toMatchObject({ status: 'superseded' });
    expect(events).toEqual([]);
    expect(client.getQueryData(['bulkVoteSummaries'])).toBeUndefined();
    client.clear();
  });

  it('never sends an old account’s write under the next account', async () => {
    const { client, wrapper } = harness();
    const preparing = deferred<void>();
    const view = renderHook(
      () =>
        useHttpMutation({
          onMutate: () => preparing.promise,
          mutationFn: (_input: void, operation) => operation.request('mutation { vote }'),
        }),
      { wrapper },
    );
    let saved!: Promise<unknown>;
    act(() => {
      saved = view.result.current.mutateWithReceipt();
    });

    signOut(client);
    await act(async () => {
      preparing.resolve();
      await saved.catch(() => {});
    });

    await expect(saved).rejects.toMatchObject({ status: 'superseded' });
    expect(transport.request).not.toHaveBeenCalled();
    client.clear();
  });

  it('ends an action’s signal at sign-out, not when its screen unmounts', () => {
    const view = renderHook(() => useHttpActionScope());
    const action = view.result.current.capture();
    view.unmount();
    expect(action.signal.aborted).toBe(false);
    expect(action.isCurrent()).toBe(false);
    expect(action.isOwnerCurrent()).toBe(true);

    void clearTokensForGeneration(captureAuthCredentialGeneration());
    expect(action.signal.aborted).toBe(true);
    expect(action.isOwnerCurrent()).toBe(false);
    action.finish();
  });

  it('refuses a read started signed out once the climber signs in, then retries it as them', async () => {
    const { client, wrapper } = harness();
    const anonymous = deferred<{ profile: string | null }>();
    transport.request.mockReturnValueOnce(anonymous.promise).mockResolvedValueOnce({ profile: 'Alex' });
    renderHook(
      () =>
        useHttpQuery({
          queryKey: ['profile'],
          retry: 1,
          retryDelay: 0,
          queryFn: (_context, operation) => operation.request<{ profile: string | null }>('{ profile }'),
        }),
      { wrapper },
    );
    await waitFor(() => expect(transport.request).toHaveBeenCalledOnce());

    await act(async () => {
      await storeTokens('signed-in-jwt', 'signed-in-refresh', '2026-12-01T00:00:00.000Z');
    });
    await act(async () => anonymous.resolve({ profile: null }));

    // The signed-out answer never lands; the retry asks again as the climber.
    await waitFor(() => expect(client.getQueryData(['profile'])).toEqual({ profile: 'Alex' }));
    expect(transport.request).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('leaves in-flight reads and writes alone across a token refresh', async () => {
    const { client, wrapper } = harness();
    const read = deferred<unknown>();
    const write = deferred<unknown>();
    transport.request.mockReturnValueOnce(read.promise).mockReturnValueOnce(write.promise);
    const events: string[] = [];
    const view = renderHook(
      () => ({
        query: useHttpQuery({
          queryKey: ['feed'],
          queryFn: (_context, operation) => operation.request<{ feed: string }>('{ feed }'),
        }),
        save: useHttpMutation({
          mutationFn: (_input: void, operation) => operation.request('mutation { vote }'),
          onSuccess: () => {
            events.push('saved');
          },
        }),
      }),
      { wrapper },
    );
    let saved!: Promise<unknown>;
    act(() => {
      saved = view.result.current.save.mutateWithReceipt();
    });
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2));

    const generation = captureAuthCredentialGeneration();
    await act(async () => {
      await storeTokensForGeneration(generation, 'refreshed-jwt', 'refreshed-refresh', '2026-12-02T00:00:00.000Z');
    });
    expect(captureAuthCredentialGeneration()).toBe(generation);
    await act(async () => {
      read.resolve({ feed: 'sessions' });
      write.resolve({ vote: true });
      await saved;
    });

    await waitFor(() => expect(client.getQueryData(['feed'])).toEqual({ feed: 'sessions' }));
    expect(events).toEqual(['saved']);
    client.clear();
  });
});

describe('a paged list keeps one page-source callback', () => {
  it('keeps capturePageSource across renders and replaces it with the key', async () => {
    const { client, wrapper } = harness();
    transport.request.mockResolvedValue({ page: 0 });
    const view = renderHook(
      ({ userId }) =>
        useHttpInfiniteQuery({
          queryKey: ['userClimbs', userId],
          pageDelivery: true,
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          queryFn: ({ pageParam }, operation) => operation.request<{ page: number }>('{ page }', { pageParam }),
        }),
      { wrapper, initialProps: { userId: 'climber' } },
    );
    const first = view.result.current.capturePageSource;
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    view.rerender({ userId: 'climber' });
    expect(view.result.current.capturePageSource).toBe(first);

    const source = first();
    expect(source.read().data.pages).toEqual([{ page: 0 }]);
    source.dispose();

    view.rerender({ userId: 'setter' });
    expect(view.result.current.capturePageSource).not.toBe(first);
    // A callback held from the old key never builds a source for the new one.
    expect(() => first()).toThrow();
    client.clear();
  });
});
