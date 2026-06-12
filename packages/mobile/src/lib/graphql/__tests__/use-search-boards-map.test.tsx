// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const requestMock = vi.fn();
vi.mock('../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
// The op + response type are mocked away; the hook only passes them through.
vi.mock('../operations', () => ({ SEARCH_BOARDS: 'SEARCH_BOARDS' }));

import { useSearchBoardsMap, type SearchBoardsMapInput } from '../use-search-boards-map';

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** The `input` object the hook handed to the GraphQL client on its last call. */
function lastInput() {
  return requestMock.mock.calls.at(-1)?.[1]?.input;
}

const base: SearchBoardsMapInput = { query: '', latitude: null, longitude: null, zoom: 11, enabled: true };

// Uses real timers (the hook's debounce is ~300ms); waitFor polls until the
// debounced query settles. Each assertion either waits for a call or waits a
// debounce window and asserts none happened.
const DEBOUNCE_SETTLE = 450;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('useSearchBoardsMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestMock.mockResolvedValue({ searchBoards: { boards: [], totalCount: 0, hasMore: false } });
  });

  it('does not fire with no coords and no query', async () => {
    renderHook(() => useSearchBoardsMap(base), { wrapper: wrapper() });
    await act(async () => {
      await sleep(DEBOUNCE_SETTLE);
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not fire for a 1-character query (needs >= 2)', async () => {
    renderHook(() => useSearchBoardsMap({ ...base, query: 'k' }), { wrapper: wrapper() });
    await act(async () => {
      await sleep(DEBOUNCE_SETTLE);
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('fires a text search for a 2+ char query (no coords)', async () => {
    renderHook(() => useSearchBoardsMap({ ...base, query: 'kilter' }), { wrapper: wrapper() });
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(lastInput()).toMatchObject({ query: 'kilter', latitude: undefined, longitude: undefined });
  });

  it('fires a location search with the zoom-derived radius and rounded coords', async () => {
    renderHook(() => useSearchBoardsMap({ ...base, latitude: 37.4, longitude: -122.1, zoom: 13 }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    // zoom 13 → 10 km; no text query so query is undefined.
    expect(lastInput()).toMatchObject({ latitude: 37.4, longitude: -122.1, radiusKm: 10, query: undefined });
  });

  it('does not refire when a tiny pan stays within the rounding precision', async () => {
    const { rerender } = renderHook((props: SearchBoardsMapInput) => useSearchBoardsMap(props), {
      wrapper: wrapper(),
      initialProps: { ...base, latitude: 37.401, longitude: -122.101, zoom: 13 },
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    // Pan by < 0.01° — rounds to the same coord, so no new request fires.
    rerender({ ...base, latitude: 37.4015, longitude: -122.1009, zoom: 13 });
    await act(async () => {
      await sleep(DEBOUNCE_SETTLE);
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('stays disabled when enabled=false even with coords', async () => {
    renderHook(() => useSearchBoardsMap({ ...base, latitude: 37.4, longitude: -122.1, enabled: false }), {
      wrapper: wrapper(),
    });
    await act(async () => {
      await sleep(DEBOUNCE_SETTLE);
    });
    expect(requestMock).not.toHaveBeenCalled();
  });
});
