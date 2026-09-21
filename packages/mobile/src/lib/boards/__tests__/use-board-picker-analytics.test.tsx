// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const track = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track }));

import { useBoardPickerAnalytics } from '../use-board-picker-analytics';
import type { BoundBoard } from '../use-activate-board';

const picked: BoundBoard = { pickSource: 'your_boards', followed: false };

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

  // #5654: Climbs' "Pick your board" is where a climber with no board is sent,
  // so its opens are their own source rather than the catch-all.
  it('names the Climbs no-board entry', () => {
    renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: null,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: false,
        fromNoBoard: true,
      }),
    );
    expect(track).toHaveBeenCalledWith('Board Picker Opened', expect.objectContaining({ source: 'no_board' }));
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
    await result.current(board, picked);
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
    await result.current({ ...board, uuid: 'wall-b', setIds: '2,1' }, picked);
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({
        sameBoard: false,
        sameConfig: true,
      }),
    );
    await result.current(board, picked);
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({
        sameBoard: true,
        sameConfig: true,
      }),
    );
    await result.current({ ...board, setIds: '1,3' }, picked);
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ sameConfig: false }),
    );
  });

  it('says which list the board was picked from and whether it landed in Your boards', async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: null,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: false,
      }),
    );
    await result.current(board, { pickSource: 'nearby', followed: true });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ pickSource: 'nearby', followed: true, hadActiveBoard: false }),
    );
    await result.current(board, { pickSource: undefined, followed: false });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ pickSource: null, followed: false }),
    );
  });

  // The picker pushed the gym finder and already counted the opening.
  it("reports only selections from a gym finder the picker opened, under the picker's source", async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: null,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: true,
        surface: 'gym_finder_from_picker',
      }),
    );
    expect(track).not.toHaveBeenCalled();
    await result.current(board, { pickSource: 'gym_finder', followed: true });
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ source: 'onboarding', pickSource: 'gym_finder', followed: true }),
    );
  });

  // Climbs' "Pick your board" picker forwards `source=no_board` to the gym map,
  // so a gym pick made there counts under that picker too.
  it("files a gym pick under the no-board picker's source", async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: null,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: false,
        fromNoBoard: true,
        surface: 'gym_finder_from_picker',
      }),
    );
    expect(track).not.toHaveBeenCalled();
    await result.current(board, { pickSource: 'gym_finder', followed: true });
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ source: 'no_board', pickSource: 'gym_finder' }),
    );
  });

  // Home and My gyms open the gym finder directly: nothing else counted that
  // opening, and its picks must not inflate the picker's own conversion.
  it('counts its own opening under its own source when the gym finder was opened directly', async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: null,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: false,
        surface: 'gym_finder',
      }),
    );
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'Board Picker Opened',
      expect.objectContaining({ source: 'gym_finder', hadActiveBoard: false }),
    );
    await result.current(board, { pickSource: 'gym_finder', followed: false });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ source: 'gym_finder', pickSource: 'gym_finder' }),
    );
  });
});
