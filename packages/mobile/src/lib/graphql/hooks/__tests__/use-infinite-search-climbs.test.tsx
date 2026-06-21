// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { SearchClimbsQueryResponse } from '../../operations';

const requestMock = vi.fn();

vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { useInfiniteSearchClimbs } from '../use-infinite-search-climbs';

const baseInput: ClimbSearchInput = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3',
  angle: 40,
  page: 999,
  pageSize: 30,
  name: 'Moonage',
};

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function lastInput(): ClimbSearchInput {
  const call = requestMock.mock.calls.at(-1);
  if (!call) throw new Error('No GraphQL request was made');
  return (call[1] as { input: ClimbSearchInput }).input;
}

function makeResponse(page: number): SearchClimbsQueryResponse {
  return {
    searchClimbs: {
      climbs: [],
      hasMore: page === 0,
    },
  };
}

describe('useInfiniteSearchClimbs', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation((_query: unknown, variables: { input: ClimbSearchInput }) =>
      Promise.resolve(makeResponse(variables.input.page ?? 0)),
    );
  });

  it('starts at backend page 0 even when the input carries a stale page field', async () => {
    renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(lastInput()).toMatchObject({ page: 0, pageSize: 30, name: 'Moonage' });
  });

  it('fetches the next backend page when hasMore is true', async () => {
    const { result } = renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(lastInput()).toMatchObject({ page: 1, pageSize: 30, name: 'Moonage' });
    expect(result.current.hasNextPage).toBe(false);
  });
});
