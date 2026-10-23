import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

// The player's "4 of 230" asks for a list's count on every tap (issue #6664).
// On a board with no download each count is a Postgres query, so repeat taps on
// the same search must come from the cache, never from a fresh request.

const requestMock = vi.fn();
vi.mock('../../offline-request', () => ({
  offlineAwareRequest: (query: unknown, variables: unknown) => requestMock(query, variables),
}));

const { fetchCachedSearchClimbsCount, searchClimbsCountQueryKey } = await import('../search-climbs-count-query');

const kilterSearch = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 } as ClimbSearchInput;

describe('fetchCachedSearchClimbsCount', () => {
  let queryClient: QueryClient;
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ searchClimbs: { totalCount: 230 } });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('sends one request for two taps on the same search', async () => {
    await expect(fetchCachedSearchClimbsCount(queryClient, kilterSearch, null)).resolves.toBe(230);
    await expect(fetchCachedSearchClimbsCount(queryClient, { ...kilterSearch }, null)).resolves.toBe(230);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('asks again for a different search', async () => {
    await fetchCachedSearchClimbsCount(queryClient, kilterSearch, null);
    await fetchCachedSearchClimbsCount(queryClient, { ...kilterSearch, angle: 45 }, null);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('reuses a count the screen already holds under the same key', async () => {
    queryClient.setQueryData(searchClimbsCountQueryKey(kilterSearch, null), { searchClimbs: { totalCount: 57 } });
    await expect(fetchCachedSearchClimbsCount(queryClient, kilterSearch, null)).resolves.toBe(57);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('keeps a followed-setters count to the account that asked', async () => {
    const followed = { ...kilterSearch, onlyFollowedAuthors: true } as ClimbSearchInput;
    await fetchCachedSearchClimbsCount(queryClient, followed, 'climber-a');
    await fetchCachedSearchClimbsCount(queryClient, followed, 'climber-b');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
