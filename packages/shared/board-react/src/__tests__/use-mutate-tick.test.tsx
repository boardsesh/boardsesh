import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUpdateTick, useDeleteTick } from '../use-mutate-tick';
import type { ExecuteHttp } from '../adapter';
import { createWrapper } from './test-helpers';

// Root keys that invalidateTickDependents refreshes on a successful edit/delete.
const TICK_DEPENDENT_KEYS = [
  'userTicks',
  'userProfileStats',
  'userClimbPercentile',
  'userAscentsFeed',
  'logbook',
  'climb',
  'searchClimbs',
  // The Sessions feed and session-detail cards aggregate from these caches and
  // must refresh when a tick they contain is edited or deleted.
  'sessionGroupedFeed',
  'sessionDetail',
];

const updateVars = {
  uuid: 'tick-1',
  input: { status: 'send' as const, difficulty: 16, quality: null, attemptCount: 2, comment: '', angle: 25 },
};

// First-element (root) of every queryKey passed to invalidateQueries.
function invalidatedRoots(calls: unknown[][]): unknown[] {
  return calls.map((call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0]);
}

describe('useUpdateTick (shared)', () => {
  it('uses the queued SQLite edit path for a signed-in Work Offline account', async () => {
    const executeHttp = vi.fn();
    const updateTickOffline = vi.fn().mockResolvedValue({
      uuid: 'tick-1',
      status: 'send',
      attemptCount: 2,
      quality: null,
      difficulty: 16,
      isBenchmark: false,
      comment: '',
      climbedAt: '2026-08-30T00:00:00.000Z',
      angle: 25,
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const { wrapper } = createWrapper({
      isAuthenticated: true,
      canLogLocally: false,
      useLocalTickStore: true,
      executeHttp: executeHttp as unknown as ExecuteHttp,
      updateTickOffline,
    });
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => result.current.mutate(updateVars));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(updateTickOffline).toHaveBeenCalledWith('tick-1', updateVars.input);
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('never falls through to HTTP when a signed-in user selected local logging', async () => {
    const executeHttp = vi.fn();
    const updateTickOffline = vi.fn().mockResolvedValue(null);
    const { wrapper } = createWrapper({
      isAuthenticated: true,
      canLogLocally: true,
      executeHttp: executeHttp as unknown as ExecuteHttp,
      updateTickOffline,
    });
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => result.current.mutate(updateVars));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('Local tick not found');
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('rejects with "Not authenticated" and touches neither transport nor caches when signed out', async () => {
    const executeHttp = vi.fn();
    const { wrapper, queryClient } = createWrapper({
      isAuthenticated: false,
      executeHttp: executeHttp as unknown as ExecuteHttp,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate(updateVars);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('Not authenticated');
    expect(executeHttp).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates every tick-dependent cache on success', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ updateTick: { uuid: 'tick-1' } });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate(updateVars);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const roots = invalidatedRoots(invalidateSpy.mock.calls);
    for (const key of TICK_DEPENDENT_KEYS) expect(roots).toContain(key);
  });

  it('does NOT invalidate caches when the mutation fails', async () => {
    const executeHttp = vi.fn().mockRejectedValue(new Error('Server exploded'));
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate(updateVars);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('writes the server response through to cached feed items before the refetch lands', async () => {
    const executeHttp = vi.fn().mockResolvedValue({
      updateTick: {
        uuid: 'tick-1',
        status: 'send',
        attemptCount: 5,
        quality: 3,
        difficulty: 16,
        isBenchmark: false,
        comment: 'sent it',
        climbedAt: '2026-07-01 10:00:00',
        angle: 25,
        updatedAt: '2026-07-03 09:00:00',
      },
    });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(['userGroupedAscentsFeed', 'user-1', {}], {
      pages: [
        {
          userGroupedAscentsFeed: {
            groups: [
              {
                key: 'climb-1-2026-07-01',
                items: [
                  { uuid: 'tick-1', status: 'attempt', attemptCount: 4, quality: null, comment: '', angle: 40 },
                  { uuid: 'tick-2', status: 'attempt', attemptCount: 1, quality: null, comment: '', angle: 40 },
                ],
              },
            ],
            totalCount: 1,
            hasMore: false,
          },
        },
      ],
      pageParams: [0],
    });
    queryClient.setQueryData(['userAscentsFeed', 'user-1', {}], {
      pages: [{ userAscentsFeed: { items: [{ uuid: 'tick-1', status: 'attempt', attemptCount: 4 }], hasMore: false } }],
      pageParams: [0],
    });
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate(updateVars);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    type GroupedCache = {
      pages: { userGroupedAscentsFeed: { groups: { items: Record<string, unknown>[] }[] } }[];
    };
    type FlatCache = { pages: { userAscentsFeed: { items: Record<string, unknown>[] } }[] };
    const groupedItems = queryClient.getQueryData<GroupedCache>(['userGroupedAscentsFeed', 'user-1', {}])?.pages[0]
      .userGroupedAscentsFeed.groups[0].items;
    // difficultyName derives client-side from the canonical grade table (the
    // mutation returns only the numeric id) so name-consumers — grade colors,
    // the day divider's top-grade label — stay consistent with the new id.
    expect(groupedItems?.[0]).toMatchObject({
      uuid: 'tick-1',
      status: 'send',
      attemptCount: 5,
      quality: 3,
      difficulty: 16,
      difficultyName: '6a/V3',
      angle: 25,
    });
    // Sibling untouched — still at the original angle.
    expect(groupedItems?.[1]).toMatchObject({ uuid: 'tick-2', status: 'attempt', attemptCount: 1, angle: 40 });
    const flatItems = queryClient.getQueryData<FlatCache>(['userAscentsFeed', 'user-1', {}])?.pages[0].userAscentsFeed
      .items;
    expect(flatItems?.[0]).toMatchObject({ uuid: 'tick-1', status: 'send', attemptCount: 5, comment: 'sent it' });
  });
});

describe('useDeleteTick (shared)', () => {
  it('uses the queued SQLite delete path for a signed-in Work Offline account', async () => {
    const executeHttp = vi.fn();
    const deleteTickOffline = vi.fn().mockResolvedValue(true);
    const { wrapper } = createWrapper({
      isAuthenticated: true,
      canLogLocally: false,
      useLocalTickStore: true,
      executeHttp: executeHttp as unknown as ExecuteHttp,
      deleteTickOffline,
    });
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => result.current.mutate('tick-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteTickOffline).toHaveBeenCalledWith('tick-1');
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('never falls through to HTTP when a signed-in user selected local logging', async () => {
    const executeHttp = vi.fn();
    const deleteTickOffline = vi.fn().mockResolvedValue(null);
    const { wrapper } = createWrapper({
      isAuthenticated: true,
      canLogLocally: true,
      executeHttp: executeHttp as unknown as ExecuteHttp,
      deleteTickOffline,
    });
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => result.current.mutate('tick-1'));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('Local tick not found');
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('rejects with "Not authenticated" and touches neither transport nor caches when signed out', async () => {
    const executeHttp = vi.fn();
    const { wrapper, queryClient } = createWrapper({
      isAuthenticated: false,
      executeHttp: executeHttp as unknown as ExecuteHttp,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('Not authenticated');
    expect(executeHttp).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates tick-dependent caches on success', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ deleteTick: true });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const roots = invalidatedRoots(invalidateSpy.mock.calls);
    for (const key of TICK_DEPENDENT_KEYS) expect(roots).toContain(key);
  });

  it('does NOT invalidate caches when the delete fails', async () => {
    const executeHttp = vi.fn().mockRejectedValue(new Error('nope'));
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('strips the deleted tick from every cached ascents-feed page before the refetch lands', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ deleteTick: true });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    // Two cached feed variants (different inputs) — the strip must hit both,
    // and only remove the deleted uuid. Invalidation's refetch never lands in
    // this harness (no network), so the post-mutate cache IS the strip result.
    const page = (uuids: string[]) => ({
      pages: [
        { userAscentsFeed: { items: uuids.map((uuid) => ({ uuid })), totalCount: uuids.length, hasMore: false } },
      ],
      pageParams: [0],
    });
    queryClient.setQueryData(['userAscentsFeed', 'user-1', { sortBy: 'recent' }], page(['tick-1', 'tick-2']));
    queryClient.setQueryData(['userAscentsFeed', 'user-1', { sortBy: 'hardest' }], page(['tick-1']));
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    type CachedFeed = { pages: { userAscentsFeed: { items: { uuid: string }[]; totalCount: number } }[] };
    const recent = queryClient.getQueryData<CachedFeed>(['userAscentsFeed', 'user-1', { sortBy: 'recent' }]);
    const hardest = queryClient.getQueryData<CachedFeed>(['userAscentsFeed', 'user-1', { sortBy: 'hardest' }]);
    expect(recent?.pages[0].userAscentsFeed.items).toEqual([{ uuid: 'tick-2' }]);
    expect(hardest?.pages[0].userAscentsFeed.items).toEqual([]);
    // totalCount stays consistent with the strip — a stale-high count would
    // leak to any surface reading the total before the refetch reconciles.
    expect(recent?.pages[0].userAscentsFeed.totalCount).toBe(1);
    expect(hardest?.pages[0].userAscentsFeed.totalCount).toBe(0);
  });

  it('strips a tick from grouped caches: shrinks its group, recomputing counts', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ deleteTick: true });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(['userGroupedAscentsFeed', 'user-1', {}], {
      pages: [
        {
          userGroupedAscentsFeed: {
            groups: [
              {
                key: 'climb-1-2026-06-20',
                items: [
                  { uuid: 'tick-1', status: 'attempt' },
                  { uuid: 'tick-2', status: 'send' },
                ],
                flashCount: 0,
                sendCount: 1,
                attemptCount: 1,
              },
            ],
            totalCount: 5,
            hasMore: false,
          },
        },
      ],
      pageParams: [0],
    });
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    type GroupedCache = {
      pages: {
        userGroupedAscentsFeed: {
          groups: { items: { uuid: string }[]; sendCount: number; attemptCount: number }[];
          totalCount: number;
        };
      }[];
    };
    const cached = queryClient.getQueryData<GroupedCache>(['userGroupedAscentsFeed', 'user-1', {}]);
    const group = cached?.pages[0].userGroupedAscentsFeed.groups[0];
    expect(group?.items.map((item) => item.uuid)).toEqual(['tick-2']);
    expect(group?.attemptCount).toBe(0);
    expect(group?.sendCount).toBe(1);
    // Group survived → totalCount (a GROUP count) unchanged.
    expect(cached?.pages[0].userGroupedAscentsFeed.totalCount).toBe(5);
  });

  it('drops an emptied group from grouped caches and decrements the group total', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ deleteTick: true });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(['userGroupedAscentsFeed', 'user-1', {}], {
      pages: [
        {
          userGroupedAscentsFeed: {
            groups: [
              { key: 'g1', items: [{ uuid: 'tick-1', status: 'send' }], flashCount: 0, sendCount: 1, attemptCount: 0 },
              { key: 'g2', items: [{ uuid: 'tick-9', status: 'send' }], flashCount: 0, sendCount: 1, attemptCount: 0 },
            ],
            totalCount: 2,
            hasMore: false,
          },
        },
      ],
      pageParams: [0],
    });
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    type GroupedCache = {
      pages: { userGroupedAscentsFeed: { groups: { key: string }[]; totalCount: number } }[];
    };
    const cached = queryClient.getQueryData<GroupedCache>(['userGroupedAscentsFeed', 'user-1', {}]);
    expect(cached?.pages[0].userGroupedAscentsFeed.groups.map((group) => group.key)).toEqual(['g2']);
    expect(cached?.pages[0].userGroupedAscentsFeed.totalCount).toBe(1);
  });

  it('decrements totalCount by ONE even when offset overlap duplicated the row across pages', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ deleteTick: true });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    // Offset pagination can return the same tick on two adjacent pages; the
    // duplicates are cache artifacts — the true total drops by exactly one.
    queryClient.setQueryData(['userAscentsFeed', 'user-1', {}], {
      pages: [
        { userAscentsFeed: { items: [{ uuid: 'tick-1' }, { uuid: 'tick-2' }], totalCount: 3, hasMore: true } },
        { userAscentsFeed: { items: [{ uuid: 'tick-1' }, { uuid: 'tick-3' }], totalCount: 3, hasMore: false } },
      ],
      pageParams: [0, 2],
    });
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-1');
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    type CachedFeed = { pages: { userAscentsFeed: { items: { uuid: string }[]; totalCount: number } }[] };
    const cached = queryClient.getQueryData<CachedFeed>(['userAscentsFeed', 'user-1', {}]);
    expect(cached?.pages.map((page) => page.userAscentsFeed.items)).toEqual([
      [{ uuid: 'tick-2' }],
      [{ uuid: 'tick-3' }],
    ]);
    expect(cached?.pages.map((page) => page.userAscentsFeed.totalCount)).toEqual([2, 2]);
  });
});
