// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const auth = vi.hoisted(() => ({ isAuthenticated: true }));
const getAuroraCredentials = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../aurora-credentials', () => ({ getAuroraCredentials }));

import { AURORA_CREDENTIALS_QUERY_KEY } from '../board-account-query-keys';
import { useBoardAccountCredentials } from '../use-board-account-credentials';
import { usePendingBoardSyncPoll } from '../use-pending-board-sync-poll';

const response = (pendingRunId: string | null) => ({
  credentials: [{ boardType: 'kilter', pendingRunId, lastSyncAt: null }],
});

describe('credentials polling', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.useFakeTimers();
    auth.isAuthenticated = true;
    getAuroraCredentials.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
  });
  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  it('useBoardAccountCredentials re-reads every 20 s while a run is pending, then stops', async () => {
    getAuroraCredentials
      .mockResolvedValueOnce(response('run-1'))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValue(response(null));
    renderHook(() => useBoardAccountCredentials(), { wrapper });
    await advance(0);
    expect(getAuroraCredentials).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(getAuroraCredentials).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(getAuroraCredentials).toHaveBeenCalledTimes(2);
  });

  it('usePendingBoardSyncPoll polls a cached pending run with no other observer', async () => {
    getAuroraCredentials.mockResolvedValue(response(null));
    queryClient.setQueryData(AURORA_CREDENTIALS_QUERY_KEY, response('run-1'));
    renderHook(() => usePendingBoardSyncPoll(), { wrapper });
    await advance(0);
    expect(getAuroraCredentials).not.toHaveBeenCalled();
    await advance(20_000);
    expect(getAuroraCredentials).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(getAuroraCredentials).toHaveBeenCalledTimes(1);
  });

  it('usePendingBoardSyncPoll starts no request when nothing is pending or signed out', async () => {
    renderHook(() => usePendingBoardSyncPoll(), { wrapper });
    await advance(60_000);
    expect(getAuroraCredentials).not.toHaveBeenCalled();
    queryClient.setQueryData(AURORA_CREDENTIALS_QUERY_KEY, response('run-1'));
    auth.isAuthenticated = false;
    renderHook(() => usePendingBoardSyncPoll(), { wrapper });
    await advance(60_000);
    expect(getAuroraCredentials).not.toHaveBeenCalled();
  });
});
