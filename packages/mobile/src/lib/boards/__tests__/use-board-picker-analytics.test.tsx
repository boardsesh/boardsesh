// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const track = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track }));

import { useBoardPickerAnalytics } from '../use-board-picker-analytics';

const board = {
  uuid: 'wall-a',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
} as UserBoard;

describe('board picker analytics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('waits for hydration and emits one opening even after selection changes', () => {
    const { rerender } = renderHook(
      ({ activeBoard }: { activeBoard: UserBoard | undefined }) =>
        useBoardPickerAnalytics({
          activeBoard,
          restoreFailed: false,
          returnTo: '/(tabs)/record',
          fromOnboarding: false,
        }),
      { initialProps: { activeBoard: undefined } as { activeBoard: UserBoard | undefined } },
    );
    expect(track).not.toHaveBeenCalled();
    rerender({ activeBoard: board });
    rerender({ activeBoard: { ...board, uuid: 'wall-b' } });
    expect(track).toHaveBeenCalledExactlyOnceWith('Board Picker Opened', {
      source: 'session',
      returnTo: '/(tabs)/record',
      hadActiveBoard: true,
      restoreFailed: false,
    });
  });

  it('records unknown rather than no board when restoration fails', () => {
    renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: undefined,
        restoreFailed: true,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: false,
      }),
    );
    expect(track).toHaveBeenCalledWith('Board Picker Opened', expect.objectContaining({ hadActiveBoard: null }));
  });

  it('normalizes setter destinations instead of sending usernames', async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: board,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs/setter/example-climber',
        fromOnboarding: false,
      }),
    );
    await result.current(board);
    for (const [, properties] of track.mock.calls) {
      expect(properties.returnTo).toBe('/(tabs)/climbs/setter/[username]');
    }
  });

  it('distinguishes the same physical board from a matching configuration', async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: board,
        restoreFailed: false,
        returnTo: '/(tabs)/record',
        fromOnboarding: false,
      }),
    );
    await result.current({ ...board, uuid: 'wall-b', setIds: '2,1' });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({
        sameBoard: false,
        sameConfig: true,
      }),
    );
    await result.current(board);
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({
        sameBoard: true,
        sameConfig: true,
      }),
    );
    await result.current({ ...board, setIds: '1,3' });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ sameConfig: false }),
    );
  });
});
