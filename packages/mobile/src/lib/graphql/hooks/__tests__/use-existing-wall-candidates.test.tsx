// @vitest-environment jsdom
//
// A gym's existing walls (#8151). The load-bearing rule: a failed lookup stays
// an error, never an empty answer, because the app reads "no walls" as "go
// ahead and add yours".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EXISTING_WALL_CANDIDATES } from '@boardsesh/graphql/operations/boards';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

const { fetchExistingWallCandidates, useExistingWallCandidates, existingWallCandidatesQueryKey } =
  await import('../use-existing-wall-candidates');

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const input = { gymUuid: 'gym-1', boardType: 'moonboard', limit: 40 };

beforeEach(() => {
  requestMock.mockReset();
});

describe('existing wall candidates', () => {
  it('asks the server with the input as given', async () => {
    requestMock.mockResolvedValue({ existingWallCandidates: { candidates: [], truncated: false } });
    await expect(fetchExistingWallCandidates(input)).resolves.toEqual({ candidates: [], truncated: false });
    expect(requestMock).toHaveBeenCalledWith(EXISTING_WALL_CANDIDATES, { input });
  });

  it('waits for a gym and a board type before asking', () => {
    renderHook(() => useExistingWallCandidates(null), { wrapper: wrapper() });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('keys the cache on the whole input', () => {
    expect(existingWallCandidatesQueryKey(input)).toEqual(['existingWallCandidates', input]);
  });

  it('stays an error when the lookup fails, never an empty list', async () => {
    requestMock.mockRejectedValue(new Error('backend down'));
    const { result } = renderHook(() => useExistingWallCandidates(input), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    // One retry, then it is the climber's Try again.
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
