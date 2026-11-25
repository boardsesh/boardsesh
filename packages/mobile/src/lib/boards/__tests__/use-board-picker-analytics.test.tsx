// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const track = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track }));

import { pickerNearbyResultCount, useBoardPickerAnalytics } from '../use-board-picker-analytics';
import type { LocationStatus } from '../../use-device-location';
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

  it.each(['climbs', 'discover'] as const)(
    'normalizes %s setter destinations instead of sending usernames',
    async (tab) => {
      const { result } = renderHook(() =>
        useBoardPickerAnalytics({
          activeBoard: board,
          restoreFailed: false,
          returnTo: `/(tabs)/${tab}/setter/example-climber`,
          fromOnboarding: false,
        }),
      );
      await result.current(board, picked);
      expect(track).toHaveBeenCalled();
      for (const [, properties] of track.mock.calls) {
        expect(properties.returnTo).toBe(`/(tabs)/${tab}/setter/[username]`);
      }
    },
  );

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

// Near you empty vs results (2026-11): the opening says where location stood,
// and each pick says what Near you had found by then.
describe('Near you on the picker events', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderPicker(initial: { locationStatus: LocationStatus; nearbyResultCount: number | null }) {
    return renderHook(
      ({ locationStatus, nearbyResultCount }: { locationStatus: LocationStatus; nearbyResultCount: number | null }) =>
        useBoardPickerAnalytics({
          activeBoard: null,
          restoreFailed: false,
          returnTo: '/(tabs)/climbs',
          fromOnboarding: false,
          locationStatus,
          nearbyResultCount,
        }),
      { initialProps: initial },
    );
  }

  it('sends the opening at once, with location as known then', () => {
    const { rerender } = renderPicker({ locationStatus: 'idle', nearbyResultCount: null });
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'Board Picker Opened',
      expect.objectContaining({ locationStatus: 'idle', hadActiveBoard: false }),
    );
    rerender({ locationStatus: 'granted', nearbyResultCount: 3 });
    expect(track).toHaveBeenCalledOnce();
  });

  // It used to fire before the "already allowed?" read came back, so
  // locationStatus always said idle.
  it('holds the opening until the permission read is back, then reports it', () => {
    type PendingProps = { locationPending: boolean; locationStatus: LocationStatus };
    const { rerender } = renderHook(
      ({ locationPending, locationStatus }: PendingProps) =>
        useBoardPickerAnalytics({
          activeBoard: null,
          restoreFailed: false,
          returnTo: '/(tabs)/climbs',
          fromOnboarding: false,
          locationStatus,
          locationPermission: locationPending ? 'unknown' : 'granted',
          locationPending,
        }),
      { initialProps: { locationPending: true, locationStatus: 'idle' } as PendingProps },
    );
    expect(track).not.toHaveBeenCalled();

    rerender({ locationPending: false, locationStatus: 'loading' });
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'Board Picker Opened',
      expect.objectContaining({ locationStatus: 'loading', locationPermission: 'granted' }),
    );
    rerender({ locationPending: false, locationStatus: 'granted' });
    expect(track).toHaveBeenCalledOnce();
  });

  it('reports what Near you had found at each pick', async () => {
    const { result, rerender } = renderPicker({ locationStatus: 'loading', nearbyResultCount: null });
    const pickBeforeTheAnswer = result.current;
    await pickBeforeTheAnswer(board, picked);
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ nearbyResultCount: null }),
    );

    rerender({ locationStatus: 'granted', nearbyResultCount: 3 });
    // The bind callback keeps its identity while the search answers.
    expect(result.current).toBe(pickBeforeTheAnswer);
    await result.current(board, picked);
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ nearbyResultCount: 3 }),
    );
  });
});

describe('pickerNearbyResultCount', () => {
  it.each<{ outcome: Parameters<typeof pickerNearbyResultCount>[0]['outcome']; expected: number | null }>([
    { outcome: 'found', expected: 4 },
    // "Nothing within 20 km" is an answer: none.
    { outcome: 'none_nearby', expected: 0 },
    { outcome: 'searching', expected: null },
    { outcome: 'nearby_error', expected: null },
    { outcome: 'location_off', expected: null },
    { outcome: 'idle', expected: null },
  ])('$outcome: $expected', ({ outcome, expected }) => {
    expect(pickerNearbyResultCount({ outcome, resultCount: 4 })).toBe(expected);
  });
});

describe('where on the picker a board was picked', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the section and the 0-based position, null when the caller did not say', async () => {
    const { result } = renderHook(() =>
      useBoardPickerAnalytics({
        activeBoard: null,
        restoreFailed: false,
        returnTo: '/(tabs)/climbs',
        fromOnboarding: false,
      }),
    );
    await result.current(board, { pickSource: 'gym_walls', followed: false, section: 'at_gym', position: 2 });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ pickSource: 'gym_walls', section: 'at_gym', position: 2 }),
    );
    await result.current(board, { pickSource: 'gym_finder', followed: false });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ section: null, position: null }),
    );
  });
});
