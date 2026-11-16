// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const track = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track }));

import {
  OPENED_NEARBY_WAIT_MS,
  pickerNearbyOpenedState,
  useBoardPickerAnalytics,
  type PickerNearbyOpenedState,
} from '../use-board-picker-analytics';
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
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'Board Picker Opened',
      {
        source: 'session',
        returnTo: '/(tabs)/record',
        hadActiveBoard: true,
        restoreFailed: false,
        nearbyResultCount: undefined,
        locationStatus: undefined,
      },
      { timestamp: expect.any(Date) },
    );
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
    expect(track).toHaveBeenCalledWith(
      'Board Picker Opened',
      expect.objectContaining({ source: 'no_board' }),
      expect.anything(),
    );
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
    expect(track).toHaveBeenCalledWith(
      'Board Picker Opened',
      expect.objectContaining({ hadActiveBoard: null }),
      expect.anything(),
    );
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
      expect.anything(),
    );
    await result.current(board, { pickSource: 'gym_finder', followed: false });
    expect(track).toHaveBeenLastCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ source: 'gym_finder', pickSource: 'gym_finder' }),
    );
  });
});

// Near you empty vs results (2026-11): the opening waits for Near you's answer
// and carries it, backdated to when the picker opened.
describe("Board Picker Opened and Near you's answer", () => {
  const SEARCHING: PickerNearbyOpenedState = { settled: false, resultCount: null, locationStatus: 'loading' };
  const FOUND_THREE: PickerNearbyOpenedState = { settled: true, resultCount: 3, locationStatus: 'granted' };

  function renderPicker(initialNearby: PickerNearbyOpenedState) {
    return renderHook(
      ({ nearby }: { nearby: PickerNearbyOpenedState }) =>
        useBoardPickerAnalytics({
          activeBoard: null,
          restoreFailed: false,
          returnTo: '/(tabs)/climbs',
          fromOnboarding: false,
          nearby,
        }),
      { initialProps: { nearby: initialNearby } },
    );
  }

  function openedCalls() {
    return track.mock.calls.filter(([name]) => name === 'Board Picker Opened');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the search, then reports its count backdated to the opening', () => {
    const { rerender } = renderPicker(SEARCHING);
    expect(openedCalls()).toHaveLength(0);

    vi.setSystemTime(new Date('2026-11-16T10:00:02Z'));
    rerender({ nearby: FOUND_THREE });
    expect(openedCalls()).toEqual([
      [
        'Board Picker Opened',
        expect.objectContaining({ nearbyResultCount: 3, locationStatus: 'granted', hadActiveBoard: false }),
        { timestamp: new Date('2026-11-16T10:00:00Z') },
      ],
    ]);
    rerender({ nearby: { ...FOUND_THREE, resultCount: 5 } });
    expect(openedCalls()).toHaveLength(1);
  });

  it('reports without the answer after the longest wait', () => {
    renderPicker(SEARCHING);
    vi.advanceTimersByTime(OPENED_NEARBY_WAIT_MS - 1);
    expect(openedCalls()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(openedCalls()).toEqual([
      [
        'Board Picker Opened',
        expect.objectContaining({ nearbyResultCount: null, locationStatus: 'loading' }),
        { timestamp: new Date('2026-11-16T10:00:00Z') },
      ],
    ]);
  });

  it('goes before a pick that comes first, so it always precedes it', async () => {
    const { result } = renderPicker(SEARCHING);
    await result.current(board, { pickSource: 'your_boards', followed: false });
    expect(track.mock.calls.map(([name]) => name)).toEqual(['Board Picker Opened', 'Board Picker Selection Completed']);
    expect(openedCalls()[0]?.[1]).toMatchObject({ nearbyResultCount: null });
    vi.advanceTimersByTime(OPENED_NEARBY_WAIT_MS);
    expect(openedCalls()).toHaveLength(1);
  });

  it('goes when the picker closes before the answer', () => {
    const { unmount } = renderPicker(SEARCHING);
    unmount();
    expect(openedCalls()).toHaveLength(1);
    vi.advanceTimersByTime(OPENED_NEARBY_WAIT_MS);
    expect(openedCalls()).toHaveLength(1);
  });

  it('reports at once when Near you will not search', () => {
    renderPicker({ settled: true, resultCount: null, locationStatus: 'idle' });
    expect(openedCalls()).toEqual([
      [
        'Board Picker Opened',
        expect.objectContaining({ nearbyResultCount: null, locationStatus: 'idle' }),
        expect.anything(),
      ],
    ]);
  });
});

describe('pickerNearbyOpenedState', () => {
  it.each<{
    name: string;
    checkedOnOpen: boolean;
    outcome: Parameters<typeof pickerNearbyOpenedState>[0]['outcome'];
    expected: Omit<PickerNearbyOpenedState, 'locationStatus'>;
  }>([
    { name: 'boards found', checkedOnOpen: true, outcome: 'found', expected: { settled: true, resultCount: 4 } },
    {
      name: 'nothing within 20 km',
      checkedOnOpen: true,
      outcome: 'none_nearby',
      expected: { settled: true, resultCount: 0 },
    },
    {
      name: 'a failed search',
      checkedOnOpen: true,
      outcome: 'nearby_error',
      expected: { settled: true, resultCount: null },
    },
    {
      name: 'location off',
      checkedOnOpen: true,
      outcome: 'location_off',
      expected: { settled: true, resultCount: null },
    },
    {
      name: 'location never asked',
      checkedOnOpen: true,
      outcome: 'idle',
      expected: { settled: true, resultCount: null },
    },
    {
      name: 'still searching',
      checkedOnOpen: true,
      outcome: 'searching',
      expected: { settled: false, resultCount: null },
    },
    // The on-open "already allowed?" read is out: idle may be about to search.
    {
      name: 'the permission read still out',
      checkedOnOpen: false,
      outcome: 'idle',
      expected: { settled: false, resultCount: null },
    },
  ])('$name', ({ checkedOnOpen, outcome, expected }) => {
    expect(pickerNearbyOpenedState({ checkedOnOpen, outcome, resultCount: 4, locationStatus: 'granted' })).toEqual({
      ...expected,
      locationStatus: 'granted',
    });
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
