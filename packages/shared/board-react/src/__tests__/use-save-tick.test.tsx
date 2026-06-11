import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSaveTick } from '../use-save-tick';
import type { ExecuteHttp } from '../adapter';
import { accumulatedLogbookQueryKey } from '../logbook-keys';
import type { LogbookEntry } from '../logbook-keys';
import type { SaveTickOptions } from '../tick-helpers';
import { createWrapper } from './test-helpers';

function tickOptions(overrides: Partial<SaveTickOptions> = {}): SaveTickOptions {
  return {
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    isBenchmark: false,
    comment: '',
    climbedAt: '2026-05-30T00:00:00.000Z',
    ...overrides,
  };
}

function savedTick(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'real-1',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-05-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('useSaveTick (shared)', () => {
  it('rejects with "Not authenticated" when the adapter reports unauthenticated', async () => {
    const { wrapper } = createWrapper({ isAuthenticated: false });
    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Not authenticated');
  });

  it('rejects with "No board selected" when boardName is null', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSaveTick(null), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('No board selected');
  });

  it('inserts an optimistic entry on mutate, keyed by a generated temp uuid', async () => {
    let resolveExecute: (value: { saveTick: ReturnType<typeof savedTick> }) => void = () => {};
    const executeHttp = vi.fn().mockImplementation(
      () =>
        new Promise<{ saveTick: ReturnType<typeof savedTick> }>((resolve) => {
          resolveExecute = resolve;
        }),
    );

    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(tickOptions({ status: 'flash' }));
    });

    await waitFor(() => {
      const cache = queryClient.getQueryData<LogbookEntry[]>(accumulatedLogbookQueryKey('kilter'));
      expect(cache?.length).toBe(1);
      expect(cache?.[0].uuid).toMatch(/^temp-/);
      expect(cache?.[0].climb_uuid).toBe('climb-1');
      expect(cache?.[0].is_ascent).toBe(true);
    });

    // Resolve the pending mutation so the test cleans up.
    await act(async () => {
      resolveExecute({ saveTick: savedTick({ uuid: 'real-1', status: 'flash' }) });
    });
  });

  it('replaces the temp entry with the saved entry on success', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ saveTick: savedTick({ uuid: 'real-77' }) });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions());
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cache = queryClient.getQueryData<LogbookEntry[]>(accumulatedLogbookQueryKey('kilter'));
    expect(cache?.length).toBe(1);
    expect(cache?.[0].uuid).toBe('real-77');
  });

  it('notifies the adapter with the saved tick timestamp and session on success', async () => {
    const onTickSaved = vi.fn();
    const executeHttp = vi.fn().mockResolvedValue({
      saveTick: savedTick({ climbedAt: '2026-06-12 07:15:00' }),
    });
    const { wrapper } = createWrapper({
      executeHttp: executeHttp as unknown as ExecuteHttp,
      onTickSaved,
    });

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions({ sessionId: 'session-1' }));
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onTickSaved).toHaveBeenCalledWith('climb-1', 40, '2026-06-12 07:15:00', 'session-1');
  });

  it('invalidates the You-page feeds on success so a new tick appears in Logbook and Sessions', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ saveTick: savedTick({ uuid: 'real-feed' }) });
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions());
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const roots = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
    );
    // Matches the edit/delete path: a freshly logged tick must refresh the
    // Logbook tab feed and the Sessions feed/detail, not just the stats charts.
    expect(roots).toContain('userAscentsFeed');
    expect(roots).toContain('sessionGroupedFeed');
    expect(roots).toContain('sessionDetail');
  });

  it('forwards a resolved presence boardId when provided', async () => {
    const executeHttp = vi.fn().mockResolvedValue({ saveTick: savedTick({ uuid: 'real-42' }) });
    const { wrapper } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions({ boardId: 4242 }));
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(executeHttp.mock.calls[0][1].input.boardId).toBe(4242);
  });

  it('rolls back the optimistic entry on error', async () => {
    const executeHttp = vi.fn().mockRejectedValue(new Error('Server exploded'));
    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(tickOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cache = queryClient.getQueryData<LogbookEntry[]>(accumulatedLogbookQueryKey('kilter'));
    expect(cache).toEqual([]);
  });

  it('does NOT recreate a logbook cache entry that was removed mid-flight', async () => {
    let resolveExecute: (value: { saveTick: ReturnType<typeof savedTick> }) => void = () => {};
    const executeHttp = vi.fn().mockImplementation(
      () =>
        new Promise<{ saveTick: ReturnType<typeof savedTick> }>((resolve) => {
          resolveExecute = resolve;
        }),
    );

    const { wrapper, queryClient } = createWrapper({ executeHttp: executeHttp as unknown as ExecuteHttp });
    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(tickOptions());
    });

    // Cache has an optimistic entry now.
    await waitFor(() => {
      const cache = queryClient.getQueryData<LogbookEntry[]>(accumulatedLogbookQueryKey('kilter'));
      expect(cache?.length).toBe(1);
    });

    // Simulate an explicit invalidation while the mutation is still in flight.
    act(() => {
      queryClient.removeQueries({ queryKey: ['logbook', 'kilter'] });
    });
    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBeUndefined();

    // Resolve. onSuccess must NOT recreate the entry — `setQueriesData` only
    // touches existing queries.
    await act(async () => {
      resolveExecute({ saveTick: savedTick({ uuid: 'real-1' }) });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBeUndefined();
  });
});
