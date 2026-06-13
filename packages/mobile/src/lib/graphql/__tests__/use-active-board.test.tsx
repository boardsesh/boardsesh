// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_BOARD } from '../operations';

const graphqlClientState = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../client', () => ({
  getHttpClient: () => ({
    request: graphqlClientState.request,
  }),
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
  id: 1,
  uuid: 'stored-1',
  boardType: 'tension',
  layoutId: 9,
  sizeId: 8,
  setIds: '7',
  angle: 25,
} as unknown as UserBoard;
const otherBoard = {
  id: 2,
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
    graphqlClientState.request.mockReset();
    await resetAsyncStorage();
  });

  it('returns the stored board', async () => {
    const { setStoredActiveBoard } = await import('../../active-board-store');
    await setStoredActiveBoard(storedBoard);

    const { useActiveBoard } = await import('../use-active-board');
    const { result } = renderHook(() => useActiveBoard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual(storedBoard));
    expect(graphqlClientState.request).not.toHaveBeenCalled();
  });

  it('hydrates a stored v2 board without id by uuid and persists the full board', async () => {
    const legacyStoredBoard = {
      uuid: 'legacy-1',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    } as unknown as UserBoard;
    const resolvedBoard = { ...legacyStoredBoard, id: 42 } as UserBoard;
    graphqlClientState.request.mockResolvedValueOnce({ board: resolvedBoard });

    const { setStoredActiveBoard, getStoredActiveBoard } = await import('../../active-board-store');
    await setStoredActiveBoard(legacyStoredBoard);

    const { useActiveBoard } = await import('../use-active-board');
    const { result } = renderHook(() => useActiveBoard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual(resolvedBoard));
    expect(graphqlClientState.request).toHaveBeenCalledWith(GET_BOARD, { boardUuid: 'legacy-1' });
    await expect(getStoredActiveBoard()).resolves.toEqual(resolvedBoard);
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
