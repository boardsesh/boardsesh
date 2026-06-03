import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { useSaveMoonBoardClimb } from '../use-save-climb';
import type { ExecuteWs } from '../adapter';
import type { SaveMoonBoardClimbOptions } from '../climb-helpers';
import { createWrapper } from './test-helpers';

function moonBoardOptions(): SaveMoonBoardClimbOptions {
  return {
    layoutId: 2,
    name: 'Test MoonBoard Climb',
    description: 'desc',
    holds: { start: ['A5'], hand: ['F10'], finish: ['G18'] },
    angle: 40,
    isDraft: true,
    userGrade: '6B',
    isBenchmark: false,
  };
}

describe('useSaveMoonBoardClimb (shared)', () => {
  it('rejects with "Authentication required to create climbs" when unauthenticated', async () => {
    const { wrapper } = createWrapper({ isAuthenticated: false });
    const { result } = renderHook(() => useSaveMoonBoardClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(moonBoardOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Authentication required to create climbs');
  });

  it('maps the options to a SaveMoonBoardClimbInput and returns the result', async () => {
    const executeWs = vi.fn().mockResolvedValue({ saveMoonBoardClimb: { uuid: 'mb-uuid' } });
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs });

    const { result } = renderHook(() => useSaveMoonBoardClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(moonBoardOptions());
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ uuid: 'mb-uuid' });

    const sentVariables = executeWs.mock.calls[0][0].variables;
    expect(sentVariables.input).toEqual({
      boardType: 'moonboard',
      layoutId: 2,
      name: 'Test MoonBoard Climb',
      description: 'desc',
      holds: { start: ['A5'], hand: ['F10'], finish: ['G18'] },
      angle: 40,
      isDraft: true,
      userGrade: '6B',
      isBenchmark: false,
      setter: undefined,
    });
  });

  it('fires showError("saveClimbFailed") on a non-duplicate failure', async () => {
    const executeWs = vi.fn().mockRejectedValue(new Error('boom'));
    const showError = vi.fn();
    const { wrapper } = createWrapper({ executeWs: executeWs as unknown as ExecuteWs, showError });

    const { result } = renderHook(() => useSaveMoonBoardClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(moonBoardOptions());
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

    const { result } = renderHook(() => useSaveMoonBoardClimb(), { wrapper });

    await act(async () => {
      result.current.mutate(moonBoardOptions());
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showError).not.toHaveBeenCalled();
  });
});
