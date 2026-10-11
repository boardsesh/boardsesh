// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicSupporter } from '@boardsesh/graphql/operations/support';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE, usePublicSupporters } from '../use-public-supporters';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function firstPage(): PublicSupporter[] {
  return Array.from({ length: MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE }, (_, index) => ({
    userId: `supporter-${index}`,
    displayName: `Climber ${index}`,
    supportedAt: '2026-09-22',
  }));
}

beforeEach(() => requestMock.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('public supporters pagination', () => {
  it('caps screenshot captures at the first loaded page', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    requestMock.mockResolvedValue({ publicSupporters: firstPage() });
    const { result } = renderHook(usePublicSupporters, { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('loads only the first page, then requests one next page on demand', async () => {
    requestMock
      .mockResolvedValueOnce({ publicSupporters: firstPage() })
      .mockResolvedValueOnce({ publicSupporters: [] });
    const { result } = renderHook(usePublicSupporters, { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][1]).toEqual({ limit: MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE, offset: 0 });
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1][1]).toEqual({
      limit: MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE,
      offset: MOBILE_PUBLIC_SUPPORTERS_PAGE_SIZE,
    });
  });

  it('retains loaded profiles when the next page fails', async () => {
    const supporters = firstPage();
    requestMock.mockResolvedValueOnce({ publicSupporters: supporters }).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(usePublicSupporters, { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.data?.pages).toEqual([{ publicSupporters: supporters }]);
  });
});
