import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { useSaveClimb, useUpdateClimb } from '../use-save-climb';
import type { ExecuteWs } from '../adapter';
import type { SaveClimbOptions } from '../climb-helpers';
import { createWrapper } from './test-helpers';

function climbOptions(): SaveClimbOptions {
  return {
    layout_id: 1,
    name: 'Test Climb',
    description: 'desc',
    is_draft: true,
    frames: 'p1234r12',
    frames_count: 1,
    frames_pace: 0,
    angle: 40,
  };
}

// First-element (root) of every queryKey passed to invalidateQueries.
function invalidatedRoots(calls: unknown[][]): unknown[] {
  return calls.map((call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0]);
}

describe('useSaveClimb (shared)', () => {
  it('rejects with "Authentication required to create climbs" when unauthenticated', async () => {
    const { wrapper } = createWrapper({ isAuthenticated: false });
    const { result } = renderHook(() => useSaveClimb('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(climbOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Authentication required to create climbs');
  });

  it('rejects with "No board selected" when boardName is null', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSaveClimb(null), { wrapper });

    await act(async () => {
      result.current.mutate(climbOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('No board selected');
  });

  it('returns the SaveClimbResponse on success', async () => {
    const executeWs = vi.fn().mockResolvedValue({ saveClimb: { uuid: 'new-uuid' } });
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });

    const { result } = renderHook(() => useSaveClimb('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(climbOptions());
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ uuid: 'new-uuid' });
  });

  it('fires showError("saveClimbFailed") on a non-duplicate failure', async () => {
    const executeWs = vi.fn().mockRejectedValue(new Error('boom'));
    const showError = vi.fn();
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs, showError });

    const { result } = renderHook(() => useSaveClimb('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(climbOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showError).toHaveBeenCalledWith('saveClimbFailed');
  });

  it('suppresses showError when the failure is a duplicate-climb rejection', async () => {
    const duplicate = new GraphQLOperationError([
      { message: 'dup', extensions: { code: 'CLIMB_IS_DUPLICATE', existingClimbUuid: 'x' } },
    ]);
    const executeWs = vi.fn().mockRejectedValue(duplicate);
    const showError = vi.fn();
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs, showError });

    const { result } = renderHook(() => useSaveClimb('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(climbOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The form-level UI renders inline guidance for duplicates, so the
    // generic toast must be skipped.
    expect(showError).not.toHaveBeenCalled();
  });

  it('busts every climb-list cache on success, including the mobile infinite list', async () => {
    const executeWs = vi.fn().mockResolvedValue({ saveClimb: { uuid: 'new-uuid' } });
    const { wrapper, queryClient } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSaveClimb('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(climbOptions());
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Mobile's list reads ['infiniteSearchClimbs'] and its ['searchClimbsCount'];
    // ['searchClimbs'] alone left a new climb invisible there until a refetch.
    expect(invalidatedRoots(invalidateSpy.mock.calls)).toEqual(
      expect.arrayContaining(['searchClimbs', 'infiniteSearchClimbs', 'searchClimbsCount', 'climb', 'myClimbs']),
    );
  });
});

describe('useUpdateClimb (shared)', () => {
  const updateInput = { uuid: 'climb-1', boardType: 'kilter', name: 'New name' };

  it('rejects with "Authentication required to update climbs" when unauthenticated', async () => {
    const { wrapper } = createWrapper({ isAuthenticated: false });
    const { result } = renderHook(() => useUpdateClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(updateInput);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Authentication required to update climbs');
  });

  it('returns the UpdateClimbResponse on success', async () => {
    const executeWs = vi.fn().mockResolvedValue({ updateClimb: { uuid: 'climb-1', isDraft: false } });
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });

    const { result } = renderHook(() => useUpdateClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(updateInput);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ uuid: 'climb-1', isDraft: false });
  });

  it('fires showError("updateClimbFailed") on failure', async () => {
    const executeWs = vi.fn().mockRejectedValue(new Error('boom'));
    const showError = vi.fn();
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs, showError });

    const { result } = renderHook(() => useUpdateClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(updateInput);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showError).toHaveBeenCalledWith('updateClimbFailed');
  });

  it('busts every climb-list cache on success, including the mobile infinite list', async () => {
    const executeWs = vi.fn().mockResolvedValue({ updateClimb: { uuid: 'climb-1', isDraft: false } });
    const { wrapper, queryClient } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(updateInput);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidatedRoots(invalidateSpy.mock.calls)).toEqual(
      expect.arrayContaining(['climb', 'searchClimbs', 'infiniteSearchClimbs', 'searchClimbsCount', 'myClimbs']),
    );
  });
});

describe('saved climb post-write mirror ordering', () => {
  it('awaits mirror completion before invalidating downloaded queries', async () => {
    let finishMirror!: () => void;
    const mirror = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishMirror = resolve;
        }),
    );
    const executeWs = vi.fn().mockResolvedValue({ saveClimb: { uuid: 'saved-uuid' } }) as unknown as ExecuteWs;
    const { wrapper, queryClient } = createWrapper({ executeWs, afterClimbWrite: mirror });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSaveClimb('spray'), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.mutateAsync(climbOptions());
    });
    await waitFor(() => expect(mirror).toHaveBeenCalledOnce());
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      finishMirror();
      await pending;
    });
    expect(invalidatedRoots(invalidate.mock.calls)).toContain('infiniteSearchClimbs');
  });

  it('keeps successful save and update results when their local mirror fails', async () => {
    const mirror = vi.fn().mockRejectedValue(new Error('SQLite unavailable'));
    const showError = vi.fn();
    const executeWs = vi.fn().mockResolvedValue({
      saveClimb: { uuid: 'saved-uuid' },
      updateClimb: { uuid: 'updated-uuid' },
    }) as unknown as ExecuteWs;
    const { wrapper } = createWrapper({ executeWs, afterClimbWrite: mirror, showError });
    const save = renderHook(() => useSaveClimb('spray'), { wrapper });
    const update = renderHook(() => useUpdateClimb(), { wrapper });
    await act(async () => {
      expect(await save.result.current.mutateAsync(climbOptions())).toEqual({ uuid: 'saved-uuid' });
      expect(await update.result.current.mutateAsync({ uuid: 'updated-uuid', boardType: 'spray' })).toEqual({
        uuid: 'updated-uuid',
      });
    });
    expect(executeWs).toHaveBeenCalledTimes(2);
    expect(showError.mock.calls).toEqual([['localClimbRefreshFailed'], ['localClimbRefreshFailed']]);
    await waitFor(() => {
      expect(save.result.current.isSuccess).toBe(true);
      expect(update.result.current.isSuccess).toBe(true);
    });
  });

  it('does not mirror a remote save after an account generation transition', async () => {
    const mirror = vi.fn();
    const executeWs = vi.fn().mockResolvedValue({ saveClimb: { uuid: 'saved-uuid' } }) as unknown as ExecuteWs;
    const { wrapper } = createWrapper({
      executeWs,
      afterClimbWrite: mirror,
      captureAuthEpoch: () => 5,
      isAuthEpochCurrent: () => false,
    });
    const { result } = renderHook(() => useSaveClimb('spray'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(climbOptions());
    });
    expect(mirror).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
