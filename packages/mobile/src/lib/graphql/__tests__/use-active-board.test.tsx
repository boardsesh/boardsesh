// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';

const interactionManagerMock = vi.hoisted(() => {
  const state = { callbacks: [] as Array<() => void> };
  return {
    state,
    runAfterInteractions: vi.fn((callback: () => void) => {
      state.callbacks.push(callback);
      return { cancel: vi.fn() };
    }),
  };
});

vi.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: interactionManagerMock.runAfterInteractions,
  },
}));

// AsyncStorage-backed preference store (in-memory).
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

const storedBoard = {
  uuid: 'stored-1',
  boardType: 'tension',
  layoutId: 9,
  sizeId: 8,
  setIds: '7',
  angle: 25,
} as unknown as UserBoard;
const otherBoard = {
  uuid: 'other-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3',
  angle: 40,
} as unknown as UserBoard;

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

async function resetAsyncStorage() {
  const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
  };
  asyncStorage.__reset();
}

describe('useActiveBoard', () => {
  beforeEach(async () => {
    vi.resetModules();
    interactionManagerMock.state.callbacks = [];
    interactionManagerMock.runAfterInteractions.mockClear();
    await resetAsyncStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the stored board', async () => {
    const { setStoredActiveBoard } = await import('../../active-board-store');
    await setStoredActiveBoard(storedBoard);

    const { useActiveBoard } = await import('../use-active-board');
    const { result } = renderHook(() => useActiveBoard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual(storedBoard));
  });

  it('returns null when nothing is stored — no server fallback', async () => {
    const { useActiveBoard } = await import('../use-active-board');
    const { result } = renderHook(() => useActiveBoard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('setActiveBoard persists and updates the cache so reads see the new board', async () => {
    const { useActiveBoard, useSetActiveBoard } = await import('../use-active-board');
    const { getStoredActiveBoard } = await import('../../active-board-store');
    const sharedWrapper = wrapper();

    const read = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    const setter = renderHook(() => useSetActiveBoard(), { wrapper: sharedWrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    expect(read.result.current.data).toBeNull();

    await act(async () => {
      await setter.result.current(storedBoard);
    });

    await waitFor(() => expect(read.result.current.data).toEqual(storedBoard));
    await expect(getStoredActiveBoard()).resolves.toEqual(storedBoard);
  });

  it('setActiveBoard switches from one board to another', async () => {
    const { setStoredActiveBoard } = await import('../../active-board-store');
    await setStoredActiveBoard(storedBoard);

    const { useActiveBoard, useSetActiveBoard } = await import('../use-active-board');
    const { getStoredActiveBoard } = await import('../../active-board-store');
    const sharedWrapper = wrapper();

    const read = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    const setter = renderHook(() => useSetActiveBoard(), { wrapper: sharedWrapper });
    await waitFor(() => expect(read.result.current.data).toEqual(storedBoard));

    await act(async () => {
      await setter.result.current(otherBoard);
    });

    await waitFor(() => expect(read.result.current.data).toEqual(otherBoard));
    await expect(getStoredActiveBoard()).resolves.toEqual(otherBoard);
  });

  it('persistActiveBoard writes storage without publishing the cache', async () => {
    const { useActiveBoard, persistActiveBoard, ACTIVE_BOARD_QUERY_KEY } = await import('../use-active-board');
    const { getStoredActiveBoard } = await import('../../active-board-store');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const read = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));
    expect(read.result.current.data).toBeNull();

    await persistActiveBoard(storedBoard);

    expect(queryClient.getQueryData(ACTIVE_BOARD_QUERY_KEY)).toBeNull();
    expect(read.result.current.data).toBeNull();
    await expect(getStoredActiveBoard()).resolves.toEqual(storedBoard);
  });

  it('publishActiveBoardAfterInteractions waits for the interaction queue before updating readers', async () => {
    const { useActiveBoard, usePublishActiveBoardAfterInteractions } = await import('../use-active-board');
    const sharedWrapper = wrapper();
    const onPublished = vi.fn();

    const read = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    const publisher = renderHook(() => usePublishActiveBoardAfterInteractions(), { wrapper: sharedWrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));

    act(() => {
      publisher.result.current(storedBoard, { onPublished });
    });

    expect(interactionManagerMock.runAfterInteractions).toHaveBeenCalledTimes(1);
    expect(read.result.current.data).toBeNull();

    act(() => {
      interactionManagerMock.state.callbacks.shift()?.();
    });

    await waitFor(() => expect(read.result.current.data).toEqual(storedBoard));
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('publishActiveBoardAfterInteractions falls back when interactions are starved', async () => {
    const { useActiveBoard, usePublishActiveBoardAfterInteractions } = await import('../use-active-board');
    const sharedWrapper = wrapper();
    const onPublished = vi.fn();

    const read = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    const publisher = renderHook(() => usePublishActiveBoardAfterInteractions(), { wrapper: sharedWrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));

    act(() => {
      publisher.result.current(otherBoard, { onPublished, timeoutMs: 1 });
    });

    expect(read.result.current.data).toBeNull();

    await waitFor(() => expect(read.result.current.data).toEqual(otherBoard));
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('publishActiveBoardAfterInteractions can be cancelled before it updates readers', async () => {
    const { useActiveBoard, usePublishActiveBoardAfterInteractions } = await import('../use-active-board');
    const sharedWrapper = wrapper();
    const onPublished = vi.fn();

    const read = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    const publisher = renderHook(() => usePublishActiveBoardAfterInteractions(), { wrapper: sharedWrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));

    const cancel = publisher.result.current(storedBoard, { onPublished, timeoutMs: 1 });
    cancel();

    act(() => {
      interactionManagerMock.state.callbacks.shift()?.();
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(read.result.current.data).toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
  });

  // Mirrors what AuthProvider.signOut does: removeQueries on the active-board
  // key must evict the staleTime: Infinity entry so the next signed-in user
  // doesn't inherit the previous user's board from the in-memory cache.
  it('removeQueries(ACTIVE_BOARD_QUERY_KEY) evicts the cached board', async () => {
    const { setStoredActiveBoard } = await import('../../active-board-store');
    await setStoredActiveBoard(storedBoard);

    const { useActiveBoard, ACTIVE_BOARD_QUERY_KEY } = await import('../use-active-board');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useActiveBoard(), { wrapper: sharedWrapper });
    await waitFor(() => expect(result.current.data).toEqual(storedBoard));

    act(() => {
      queryClient.removeQueries({ queryKey: ACTIVE_BOARD_QUERY_KEY });
    });

    expect(queryClient.getQueryData(ACTIVE_BOARD_QUERY_KEY)).toBeUndefined();
  });
});
