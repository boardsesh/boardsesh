// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import { useMyBoardSerialConfigs } from '../use-my-board-serial-configs';

const harness = vi.hoisted(() => ({
  request: vi.fn(),
  authToken: 'climber-token' as string | null | undefined,
  authTokenError: false,
}));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: harness.request }) }));
vi.mock('../../graphql/use-auth-token', () => ({
  useAuthToken: () => ({
    data: harness.authToken,
    isError: harness.authTokenError,
    fetchStatus: harness.authToken === undefined && !harness.authTokenError ? 'fetching' : 'idle',
  }),
}));

const serialNumbers = ['751945'];
const savedBoard = (boardUuid: string): BoardSerialConfig => ({
  serialNumber: serialNumbers[0],
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  apiLevel: 3,
  updatedAt: '2026-01-02T00:00:00.000Z',
  boardUuid,
  boardSlug: boardUuid,
});

function cachedHook() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['myBoardSerialConfigs', 'climber-token', serialNumbers], {
    myBoardSerialConfigs: [savedBoard('old-board')],
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { ...renderHook(() => useMyBoardSerialConfigs(serialNumbers), { wrapper: Wrapper }), queryClient };
}

describe('useMyBoardSerialConfigs cached preference refresh', () => {
  beforeEach(() => {
    harness.request.mockReset();
    harness.authToken = 'climber-token';
    harness.authTokenError = false;
  });

  it('keeps cached candidates untappable until the new board mapping arrives', async () => {
    let finishRequest!: (response: { myBoardSerialConfigs: BoardSerialConfig[] }) => void;
    harness.request.mockReturnValue(
      new Promise((resolve) => {
        finishRequest = resolve;
      }),
    );
    const { result, queryClient } = cachedHook();

    await waitFor(() => expect(harness.request).toHaveBeenCalledTimes(1));
    // React Query retains the old data during a background refetch (isLoading
    // is false); the sheet must still show its resolving state instead of rows.
    expect(result.current.data[0].boardUuid).toBe('old-board');
    expect(result.current.isResolving).toBe(true);

    await act(async () => finishRequest({ myBoardSerialConfigs: [savedBoard('new-board')] }));
    await waitFor(() => expect(result.current.isResolving).toBe(false));
    expect(result.current.data[0].boardUuid).toBe('new-board');
    queryClient.clear();
  });

  it('discards an old mapping after a failed refetch so manual choices remain', async () => {
    let failRequest!: (error: Error) => void;
    harness.request.mockReturnValue(
      new Promise((_resolve, reject) => {
        failRequest = reject;
      }),
    );
    const { result, queryClient } = cachedHook();
    await waitFor(() => expect(result.current.isResolving).toBe(true));

    await act(async () => failRequest(new Error('offline')));
    await waitFor(() => expect(result.current.isResolving).toBe(false));
    expect(result.current.data).toEqual([]);
    queryClient.clear();
  });

  it('does not apply a cached signed-in mapping when auth is signed out', async () => {
    harness.authToken = null;
    const { result, queryClient } = cachedHook();
    expect(result.current.isResolving).toBe(false);
    expect(result.current.data).toEqual([]);
    expect(harness.request).not.toHaveBeenCalled();
    queryClient.clear();
  });

  // Offline the quickstart used to sit on "Loading boards…": a lookup that can't
  // answer is done waiting, and the public candidates show.
  it('stops waiting on a lookup paused for want of a network', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'online' } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    onlineManager.setOnline(false);
    try {
      const { result } = renderHook(() => useMyBoardSerialConfigs(serialNumbers), { wrapper: Wrapper });

      await waitFor(() => expect(result.current.isResolving).toBe(false));
      expect(result.current.data).toEqual([]);
      expect(harness.request).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
      queryClient.clear();
    }
  });

  it('stops waiting on a failed lookup, even while it tries again', async () => {
    harness.request.mockRejectedValueOnce(new Error('offline'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useMyBoardSerialConfigs(serialNumbers), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isResolving).toBe(false));

    harness.request.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      void queryClient.refetchQueries({ queryKey: ['myBoardSerialConfigs'] });
    });
    expect(result.current.isResolving).toBe(false);
    expect(result.current.data).toEqual([]);
    queryClient.clear();
  });

  it('waits for the stored sign-in, but not on one that failed to load', () => {
    harness.authToken = undefined;
    const waiting = cachedHook();
    expect(waiting.result.current.isResolving).toBe(true);
    waiting.queryClient.clear();

    harness.authTokenError = true;
    const failed = cachedHook();
    expect(failed.result.current.isResolving).toBe(false);
    failed.queryClient.clear();
  });
});
