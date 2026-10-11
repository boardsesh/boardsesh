// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import { useMyBoardSerialConfigs } from '../use-my-board-serial-configs';

const harness = vi.hoisted(() => ({ request: vi.fn(), authToken: 'climber-token' as string | null | undefined }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: harness.request }) }));
vi.mock('../../graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: harness.authToken }) }));

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
});
