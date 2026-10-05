import { describe, expect, it } from 'vitest';
import {
  FIRST_BOARD_PICKER_HREF,
  NO_BOARD_PICKER_HREF,
  isFirstBoardMode,
  isNoBoardEntry,
  noBoardPickerHref,
  noBoardPickerTrigger,
} from '../first-board-mode';
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

describe('isNoBoardEntry', () => {
  it("is on for the href Climbs' Find my board pushes", () => {
    expect(isNoBoardEntry(NO_BOARD_PICKER_HREF.params)).toBe(true);
  });

  // The no-board entry is an ordinary pick, never onboarding: it must not turn
  // on first-board mode, which closes out first-run on the bind.
  it('is not first-board mode', () => {
    expect(isFirstBoardMode(NO_BOARD_PICKER_HREF.params)).toBe(false);
    expect(isNoBoardEntry(FIRST_BOARD_PICKER_HREF.params)).toBe(false);
    expect(isNoBoardEntry({})).toBe(false);
  });
});

describe('firstBoardGymState', () => {
  const tapped = {
    chosen: true,
    locationStatus: 'granted' as const,
    nearbyLoading: false,
    nearbyFailed: false,
    nearbyCount: 0,
  };

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

  // Dead gym wifi or a backend error must not read as "Nothing within 20 km" to
  // a climber standing in a gym.
  it('says the lookup failed instead of claiming nothing is nearby', () => {
    expect(firstBoardGymState({ ...tapped, nearbyFailed: true })).toBe('nearby_error');
  });

  it('searches again while a retry after a failure is in flight', () => {
    expect(firstBoardGymState({ ...tapped, nearbyFailed: true, nearbyLoading: true })).toBe('searching');
  });

  it('keeps boards already on screen when a refetch fails', () => {
    expect(firstBoardGymState({ ...tapped, nearbyFailed: true, nearbyCount: 2 })).toBe('found');
  });

  it('puts a location problem ahead of a failed lookup', () => {
    expect(firstBoardGymState({ ...tapped, locationStatus: 'denied', nearbyFailed: true })).toBe('location_off');
  });

  // Location Services off for the whole phone answers the prompt "granted" and
  // then fails the fix; to the climber that is the same as a denial.
  it('reads a denial and a failed fix the same way', () => {
    expect(firstBoardGymState({ ...tapped, locationStatus: 'denied' })).toBe('location_off');
    expect(firstBoardGymState({ ...tapped, locationStatus: 'unavailable' })).toBe('location_off');
  });
});

// What on Climbs' no-board state opened the picker, so a tap on a previewed
// climb can be told from a deliberate "Find my board".
describe('noBoardPickerHref', () => {
  it('is the no-board entry, tagged with what opened it', () => {
    expect(noBoardPickerHref('preview_row')).toEqual({
      pathname: '/boards',
      params: { source: 'no_board', trigger: 'preview_row' },
    });
    expect(isNoBoardEntry(noBoardPickerHref('cta').params)).toBe(true);
    expect(isFirstBoardMode(noBoardPickerHref('cta').params)).toBe(false);
  });

  it('round-trips through the route params', () => {
    expect(noBoardPickerTrigger(noBoardPickerHref('cta').params)).toBe('cta');
    expect(noBoardPickerTrigger(noBoardPickerHref('preview_row').params)).toBe('preview_row');
  });
});

describe('noBoardPickerTrigger', () => {
  // A link from a build that predates the param carries none.
  it('is null for the untagged no-board entry', () => {
    expect(noBoardPickerTrigger(NO_BOARD_PICKER_HREF.params)).toBeNull();
  });

  it('is null for a value this build does not know', () => {
    expect(noBoardPickerTrigger({ source: 'no_board', trigger: 'banner' })).toBeNull();
  });

  // A stray param on another picker link must not file that opening under the preview.
  it('is null outside the no-board entry', () => {
    expect(noBoardPickerTrigger({ source: 'onboarding', trigger: 'preview_row' })).toBeNull();
    expect(noBoardPickerTrigger({ trigger: 'cta' })).toBeNull();
  });
});
