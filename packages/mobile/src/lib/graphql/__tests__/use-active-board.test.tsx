// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';

const persistedAccessMode = vi.hoisted(() => ({ value: 'account' as 'account' | 'local' }));
const asyncStorageWriteGate = vi.hoisted(() => ({
  blockNextSet: false,
  release: null as (() => void) | null,
}));

vi.mock('expo-secure-store', () => ({
  getItem: () => persistedAccessMode.value,
  setItem: vi.fn(),
}));

// AsyncStorage-backed preference store (in-memory).
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        if (asyncStorageWriteGate.blockNextSet) {
          asyncStorageWriteGate.blockNextSet = false;
          await new Promise<void>((resolve) => {
            asyncStorageWriteGate.release = resolve;
          });
          asyncStorageWriteGate.release = null;
        }
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
    persistedAccessMode.value = 'account';
    asyncStorageWriteGate.blockNextSet = false;
    asyncStorageWriteGate.release = null;
    await resetAsyncStorage();
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

  it('fences a stale conditional heal as soon as a newer user selection starts', async () => {
    const { getActiveBoardWriteGeneration, useSetActiveBoard, useSetActiveBoardIfCurrentGeneration } =
      await import('../use-active-board');
    const { getStoredActiveBoard } = await import('../../active-board-store');
    const sharedWrapper = wrapper();
    const setter = renderHook(() => useSetActiveBoard(), { wrapper: sharedWrapper });
    const conditionalSetter = renderHook(() => useSetActiveBoardIfCurrentGeneration(), { wrapper: sharedWrapper });
    const staleGeneration = getActiveBoardWriteGeneration();

    let staleHealAccepted = true;
    await act(async () => {
      const userWrite = setter.result.current(otherBoard);
      // The generation changes synchronously, before the AsyncStorage promise
      // above settles or React Query has a chance to render the new board.
      expect(getActiveBoardWriteGeneration()).toBe(staleGeneration + 1);
      staleHealAccepted = await conditionalSetter.result.current(staleGeneration, storedBoard);
      await userWrite;
    });

    expect(staleHealAccepted).toBe(false);
    await expect(getStoredActiveBoard()).resolves.toEqual(otherBoard);
  });

  it('keeps a queued account write in the account namespace after switching to local mode', async () => {
    const { useSetActiveBoard } = await import('../use-active-board');
    const { getStoredActiveBoard } = await import('../../active-board-store');
    const setter = renderHook(() => useSetActiveBoard(), { wrapper: wrapper() });

    asyncStorageWriteGate.blockNextSet = true;
    let firstAccountWrite!: Promise<void>;
    act(() => {
      firstAccountWrite = setter.result.current(storedBoard);
    });
    await waitFor(() => expect(asyncStorageWriteGate.release).not.toBeNull());

    // This intent is queued behind the blocked write while account mode is
    // still selected. Its physical storage key must be captured now.
    let queuedAccountWrite!: Promise<void>;
    act(() => {
      queuedAccountWrite = setter.result.current(otherBoard);
    });
    persistedAccessMode.value = 'local';
    asyncStorageWriteGate.release?.();

    await act(async () => {
      await Promise.all([firstAccountWrite, queuedAccountWrite]);
    });

    persistedAccessMode.value = 'account';
    await expect(getStoredActiveBoard()).resolves.toEqual(otherBoard);
    persistedAccessMode.value = 'local';
    await expect(getStoredActiveBoard()).resolves.toBeNull();
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
