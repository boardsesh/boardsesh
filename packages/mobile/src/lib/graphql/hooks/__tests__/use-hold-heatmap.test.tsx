// @vitest-environment jsdom
// useHoldHeatmap routes by source: the downloaded board through the local-only
// interceptor, the server directly for an admin, and nothing at all otherwise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { HOLD_HEATMAP_QUERY } from '@boardsesh/graphql/operations';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  offlineAwareRequest: vi.fn(),
}));

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../offline-request', () => ({ offlineAwareRequest: mocks.offlineAwareRequest }));

import { useHoldHeatmap } from '../use-hold-heatmap';

const input: ClimbSearchInput = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40, minGrade: 16 };
const stat = (holdId: number) => ({
  holdId,
  totalUses: 3,
  startingUses: 1,
  handUses: 2,
  footUses: 0,
  finishUses: 0,
  totalAscents: 9,
  averageDifficulty: 18,
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({ holdHeatmap: [stat(2)] });
  mocks.offlineAwareRequest.mockResolvedValue({ holdHeatmap: [stat(1)] });
});

describe('useHoldHeatmap', () => {
  it('local: reads through the offline interceptor and indexes the stats by hold', async () => {
    const { result } = renderHook(() => useHoldHeatmap(input, 'local', true), { wrapper });
    await waitFor(() => expect(result.current.holdStats).toEqual([stat(1)]));
    expect(mocks.offlineAwareRequest).toHaveBeenCalledWith(HOLD_HEATMAP_QUERY, { input });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(result.current.statsByHoldId.get(1)).toEqual(stat(1));
  });

  it('network (admin): asks the server directly', async () => {
    const { result } = renderHook(() => useHoldHeatmap(input, 'network', true), { wrapper });
    await waitFor(() => expect(result.current.holdStats).toEqual([stat(2)]));
    expect(mocks.request).toHaveBeenCalledWith(HOLD_HEATMAP_QUERY, { input });
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
  });

  it('download, or switched off: runs no query at all', async () => {
    const { result: download } = renderHook(() => useHoldHeatmap(input, 'download', true), { wrapper });
    const { result: off } = renderHook(() => useHoldHeatmap(input, 'local', false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(download.current.isFetching).toBe(false);
    expect(off.current.isFetching).toBe(false);
    expect(download.current.holdStats).toEqual([]);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
  });

  it('retries once, so an interrupted index build recovers on its own', async () => {
    mocks.offlineAwareRequest.mockRejectedValueOnce(new Error('interrupted'));
    const { result } = renderHook(() => useHoldHeatmap(input, 'local', true), {
      // No client-level retry override: the hook's own `retry: 1` decides.
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: new QueryClient() }, children),
    });
    await waitFor(() => expect(result.current.holdStats).toEqual([stat(1)]), { timeout: 3000 });
    expect(mocks.offlineAwareRequest).toHaveBeenCalledTimes(2);
  });

  it('flags the local fallback as unavailable rather than empty', async () => {
    mocks.offlineAwareRequest.mockResolvedValue({ holdHeatmap: [], unavailable: true });
    const { result } = renderHook(() => useHoldHeatmap(input, 'local', true), { wrapper });
    await waitFor(() => expect(result.current.isUnavailable).toBe(true));
    expect(result.current.holdStats).toEqual([]);
  });
});
