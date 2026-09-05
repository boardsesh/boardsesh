// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

// What is under test is the hook's OWN logic: the input it builds, the `enabled`
// gate it computes, the `isSettled` tri-state it derives, and the no-board
// fallback. Everything else stays real — in particular React Query, because
// `isSuccess` / `isError` are its answers and hand-rolling them in a mock would
// be the "test a proxy instead of the thing" trap this file exists to close: the
// board-switch harness stubs this whole hook with an idealised
// `isSettled: !enabled || settled`, so a bug in the real derivation surfaces
// nowhere else.
//
// `../../../lib/graphql/hooks` itself is stubbed only because importing it drags
// in react-native's Flow sources, which the test bundler cannot parse. The stub
// mirrors the real `useSearchClimbs` wiring one for one (query key, select,
// enabled, staleTime/gcTime pass-through) over a controllable transport, so the
// query state our hook reads is genuine.

type SearchInput = Record<string, unknown>;
type SearchResult = { climbs: { uuid: string }[]; totalCount: number };

const transport = vi.hoisted(() => ({
  fetchClimbs: vi.fn<(input: SearchInput) => Promise<{ searchClimbs: SearchResult }>>(),
  enabledCalls: [] as boolean[],
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useSearchClimbs: (input: SearchInput, enabled = true, options?: { staleTime?: number; gcTime?: number }) => {
    transport.enabledCalls.push(enabled);
    return useQuery({
      queryKey: ['searchClimbs', input],
      queryFn: () => transport.fetchClimbs(input),
      select: (data: { searchClimbs: SearchResult }) => data.searchClimbs,
      enabled,
      staleTime: options?.staleTime,
      gcTime: options?.gcTime,
    });
  },
}));

const { useBoardContinuationFeed, BOARD_CONTINUATION_PAGE_SIZE } = await import('../use-board-continuation-feed');

const TENSION_BOARD = { boardName: 'tension', layoutId: 8, sizeId: 20, setIds: '3', angle: 40 };

function makeSearchResult(uuids: string[]): { searchClimbs: SearchResult } {
  return { searchClimbs: { climbs: uuids.map((uuid) => ({ uuid })), totalCount: uuids.length } };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  transport.fetchClimbs.mockReset();
  transport.enabledCalls = [];
  queryClient = new QueryClient({
    // A retried failure stays pending through backoff, so the error case could
    // never reach a settled state.
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  queryClient.clear();
});

describe('useBoardContinuationFeed', () => {
  it('returns the board feed and settles once it lands', async () => {
    transport.fetchClimbs.mockResolvedValue(makeSearchResult(['tension-1', 'tension-2']));

    const { result } = renderHook(() => useBoardContinuationFeed(TENSION_BOARD, true), { wrapper });

    // In flight. An empty feed here must NOT read as "this board has no feed" —
    // the queue provider would announce a dead end and contradict itself.
    expect(result.current.isSettled).toBe(false);
    expect(result.current.climbs).toEqual([]);

    await waitFor(() => expect(result.current.isSettled).toBe(true));
    expect(result.current.climbs.map((climb) => climb.uuid)).toEqual(['tension-1', 'tension-2']);
  });

  it('asks for page 0 of the board it was handed', async () => {
    transport.fetchClimbs.mockResolvedValue(makeSearchResult([]));

    renderHook(() => useBoardContinuationFeed(TENSION_BOARD, true), { wrapper });

    await waitFor(() => expect(transport.fetchClimbs).toHaveBeenCalled());
    expect(transport.fetchClimbs.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        boardName: 'tension',
        layoutId: 8,
        sizeId: 20,
        setIds: '3',
        angle: 40,
        page: 0,
        pageSize: BOARD_CONTINUATION_PAGE_SIZE,
      }),
    );
  });

  it('settles on an error too, so a caller never waits forever on a dead feed', async () => {
    transport.fetchClimbs.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useBoardContinuationFeed(TENSION_BOARD, true), { wrapper });

    expect(result.current.isSettled).toBe(false);

    await waitFor(() => expect(result.current.isSettled).toBe(true));
    expect(result.current.climbs).toEqual([]);
  });

  it('fires no query while disabled, and reports settled because nothing is coming', async () => {
    const { result } = renderHook(() => useBoardContinuationFeed(TENSION_BOARD, false), { wrapper });

    expect(result.current.climbs).toEqual([]);
    expect(result.current.isSettled).toBe(true);
    // The gate the queue sheet added: both readers stay mounted for the whole
    // session, so an ungated feed would fetch continuously.
    expect(transport.enabledCalls.every((enabled) => enabled === false)).toBe(true);
    await waitFor(() => expect(transport.fetchClimbs).not.toHaveBeenCalled());
  });

  it('falls back without throwing when there is no active board, and still fetches nothing', async () => {
    const { result } = renderHook(() => useBoardContinuationFeed(null, true), { wrapper });

    expect(result.current.climbs).toEqual([]);
    expect(result.current.isSettled).toBe(true);
    // `enabled` is forced false by the missing board even though the caller
    // asked for the feed, so the placeholder input is never fetched.
    expect(transport.enabledCalls.every((enabled) => enabled === false)).toBe(true);
    await waitFor(() => expect(transport.fetchClimbs).not.toHaveBeenCalled());
  });

  it('arms the query when a board arrives after a null first render', async () => {
    transport.fetchClimbs.mockResolvedValue(makeSearchResult(['t-1']));

    const { result, rerender } = renderHook(
      ({ board }: { board: typeof TENSION_BOARD | null }) => useBoardContinuationFeed(board, true),
      { wrapper, initialProps: { board: null as typeof TENSION_BOARD | null } },
    );
    expect(transport.fetchClimbs).not.toHaveBeenCalled();

    rerender({ board: TENSION_BOARD });

    await waitFor(() => expect(result.current.climbs.map((climb) => climb.uuid)).toEqual(['t-1']));
    expect(result.current.isSettled).toBe(true);
  });
});
