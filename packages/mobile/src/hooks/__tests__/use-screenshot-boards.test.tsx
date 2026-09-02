// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { fetchAllMyBoards } = vi.hoisted(() => ({
  fetchAllMyBoards: vi.fn(),
}));

// The pagination walk itself is covered by `fetch-all-my-boards.test.ts`; what
// matters here is who calls it and when.
vi.mock('../../lib/graphql/hooks', () => ({ fetchAllMyBoards }));

import { useScreenshotBoards } from '../use-screenshot-boards';

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useScreenshotBoards', () => {
  const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

  beforeEach(() => {
    fetchAllMyBoards.mockReset();
    fetchAllMyBoards.mockResolvedValue([{ uuid: 'board-1', name: "Marco's Board" }]);
  });

  afterEach(() => {
    if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
  });

  it('walks every page so a wall on page two is still findable by name', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';

    const { result } = renderHook(() => useScreenshotBoards(true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(fetchAllMyBoards).toHaveBeenCalledTimes(1);
  });

  it('never fetches in a normal build, whatever the caller asks for', async () => {
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

    const { result } = renderHook(() => useScreenshotBoards(true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).toEqual([]));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
  });

  it('waits for the caller, so the roster is not fetched before sign-in', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';

    const { result } = renderHook(() => useScreenshotBoards(false), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).toEqual([]));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
  });

  it('hands back one stable empty array, so a consumer effect does not re-run on every render', () => {
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

    const { result, rerender } = renderHook(() => useScreenshotBoards(true), { wrapper: wrapper() });
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
