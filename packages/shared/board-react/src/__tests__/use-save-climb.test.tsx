import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { useSaveClimb, useSaveMoonBoardClimb, useUpdateClimb, useUpdateMoonBoardClimb } from '../use-save-climb';
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
});

describe('MoonBoard climb mutations (shared)', () => {
  it('sends the dedicated save mutation payload unchanged', async () => {
    const executeWs = vi.fn().mockResolvedValue({ saveMoonBoardClimb: { uuid: 'moon-1' } });
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });
    const { result } = renderHook(() => useSaveMoonBoardClimb(), { wrapper });
    const input = {
      boardType: 'moonboard',
      layoutId: 3,
      name: 'Moon problem',
      holds: { start: ['A1'], hand: ['D3'], finish: ['K18'] },
      angle: 40,
    };

    await act(async () => result.current.mutate(input));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(executeWs).toHaveBeenCalledWith(expect.objectContaining({ variables: { input } }));
  });

  it('sends an omitted benchmark flag unchanged on update', async () => {
    const executeWs = vi.fn().mockResolvedValue({ updateMoonBoardClimb: { uuid: 'moon-1', isDraft: true } });
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });
    const { result } = renderHook(() => useUpdateMoonBoardClimb(), { wrapper });
    const input = { uuid: 'moon-1', boardType: 'moonboard', name: 'Edited' };

    await act(async () => result.current.mutate(input));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(executeWs).toHaveBeenCalledWith(expect.objectContaining({ variables: { input } }));
  });
});
