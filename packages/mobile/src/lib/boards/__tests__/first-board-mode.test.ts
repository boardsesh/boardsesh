import { describe, expect, it } from 'vitest';
import { FIRST_BOARD_PICKER_HREF, isFirstBoardMode } from '../first-board-mode';
import { firstBoardGymState } from '../first-board-gym-state';

describe('isFirstBoardMode', () => {
  it('is on for the href the launch gate pushes', () => {
    expect(isFirstBoardMode(FIRST_BOARD_PICKER_HREF.params)).toBe(true);
  });

  it('needs both params', () => {
    expect(isFirstBoardMode({ source: 'onboarding' })).toBe(false);
    expect(isFirstBoardMode({ firstBoard: '1' })).toBe(false);
    expect(isFirstBoardMode({})).toBe(false);
  });

  // A stray param on an ordinary picker link must not turn a climber's board
  // list into a first-run screen.
  it('stays off for any other source or value', () => {
    expect(isFirstBoardMode({ source: 'board_picker', firstBoard: '1' })).toBe(false);
    expect(isFirstBoardMode({ source: 'onboarding', firstBoard: 'true' })).toBe(false);
  });
});

describe('firstBoardGymState', () => {
  const tapped = { chosen: true, locationStatus: 'granted' as const, nearbyLoading: false, nearbyCount: 0 };

  it('shows nothing until "At a gym" is tapped', () => {
    expect(firstBoardGymState({ ...tapped, chosen: false, nearbyCount: 3 })).toBe('idle');
  });

  it('searches while location is asked for and while the boards load', () => {
    expect(firstBoardGymState({ ...tapped, locationStatus: 'idle' })).toBe('searching');
    expect(firstBoardGymState({ ...tapped, locationStatus: 'loading' })).toBe('searching');
    expect(firstBoardGymState({ ...tapped, nearbyLoading: true })).toBe('searching');
  });

  it('lists the boards it found', () => {
    expect(firstBoardGymState({ ...tapped, nearbyCount: 2 })).toBe('found');
    // A refetch in flight keeps the list on screen.
    expect(firstBoardGymState({ ...tapped, nearbyCount: 2, nearbyLoading: true })).toBe('found');
  });

  it('says when nothing is within 20 km', () => {
    expect(firstBoardGymState(tapped)).toBe('none_nearby');
  });

  // Location Services off for the whole phone answers the prompt "granted" and
  // then fails the fix; to the climber that is the same as a denial.
  it('reads a denial and a failed fix the same way', () => {
    expect(firstBoardGymState({ ...tapped, locationStatus: 'denied' })).toBe('location_off');
    expect(firstBoardGymState({ ...tapped, locationStatus: 'unavailable' })).toBe('location_off');
  });
});
