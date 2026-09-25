import { describe, expect, it } from 'vitest';
import {
  decideFirstBoardPicker,
  FIRST_BOARD_PICKER_MAX_SHOWS,
  isNewAccount,
  type FirstBoardPickerInput,
} from '../first-board-picker-decision';

const NOW_MS = Date.parse('2026-09-21T12:00:00.000Z');

// A day-old account, signed in, online, never shown the picker: the one that gets it.
const eligible: FirstBoardPickerInput = {
  userId: 'user-new',
  accountCreatedAt: '2026-09-20T12:00:00.000Z',
  nowMs: NOW_MS,
  enabled: true,
  offline: false,
  timesShown: 0,
};

describe('isNewAccount', () => {
  it('is true up to and including seven days old', () => {
    expect(isNewAccount('2026-09-21T11:00:00.000Z', NOW_MS)).toBe(true);
    expect(isNewAccount('2026-09-14T12:00:00.000Z', NOW_MS)).toBe(true);
  });

  it('is false a minute past seven days', () => {
    expect(isNewAccount('2026-09-14T11:59:00.000Z', NOW_MS)).toBe(false);
  });

  // A phone clock running behind the server puts the creation time in the future.
  it('treats a creation time in the future as brand new', () => {
    expect(isNewAccount('2026-09-21T13:00:00.000Z', NOW_MS)).toBe(true);
  });

  it('is false when the creation time is missing or does not parse', () => {
    expect(isNewAccount(undefined, NOW_MS)).toBe(false);
    expect(isNewAccount(null, NOW_MS)).toBe(false);
    expect(isNewAccount('', NOW_MS)).toBe(false);
    expect(isNewAccount('yesterday', NOW_MS)).toBe(false);
  });
});

describe('decideFirstBoardPicker', () => {
  it('opens for a new, known, online account that has not seen it', () => {
    expect(decideFirstBoardPicker(eligible)).toBe('presented');
  });

  describe('the account', () => {
    it('stays shut until the profile has an id', () => {
      expect(decideFirstBoardPicker({ ...eligible, userId: undefined })).toBe('profile_unavailable');
    });

    it('stays shut without a creation time to judge the age by', () => {
      expect(decideFirstBoardPicker({ ...eligible, accountCreatedAt: null })).toBe('profile_unavailable');
      expect(decideFirstBoardPicker({ ...eligible, accountCreatedAt: undefined })).toBe('profile_unavailable');
      expect(decideFirstBoardPicker({ ...eligible, accountCreatedAt: 'not a date' })).toBe('profile_unavailable');
    });

    it('stays shut for an account older than seven days', () => {
      expect(decideFirstBoardPicker({ ...eligible, accountCreatedAt: '2025-01-01T00:00:00.000Z' })).toBe(
        'not_new_account',
      );
    });
  });

  describe('the showing cap', () => {
    it('opens a second time after one showing', () => {
      expect(decideFirstBoardPicker({ ...eligible, timesShown: 1 })).toBe('presented');
    });

    it('stays shut after two showings', () => {
      expect(FIRST_BOARD_PICKER_MAX_SHOWS).toBe(2);
      expect(decideFirstBoardPicker({ ...eligible, timesShown: 2 })).toBe('shown_twice');
      expect(decideFirstBoardPicker({ ...eligible, timesShown: 5 })).toBe('shown_twice');
    });

    it('stays shut when the counter could not be read', () => {
      expect(decideFirstBoardPicker({ ...eligible, timesShown: null })).toBe('storage_error');
    });
  });

  describe('the moment', () => {
    it('stays shut offline', () => {
      expect(decideFirstBoardPicker({ ...eligible, offline: true })).toBe('offline');
    });

    it('stays shut with the kill switch on', () => {
      expect(decideFirstBoardPicker({ ...eligible, enabled: false })).toBe('kill_switch');
    });
  });

  // The gate runs the decision once with a stand-in count of 0 before it reads
  // the counter. That only works if the account's own facts are checked first,
  // and a killed or offline launch still says whether the account qualified.
  describe('order', () => {
    it('names the account before the kill switch or the connection', () => {
      const oldAccount = { ...eligible, accountCreatedAt: '2025-01-01T00:00:00.000Z' };
      expect(decideFirstBoardPicker({ ...oldAccount, enabled: false, offline: true })).toBe('not_new_account');
      expect(decideFirstBoardPicker({ ...eligible, userId: undefined, enabled: false })).toBe('profile_unavailable');
    });

    it('names the kill switch before the connection or the cap', () => {
      expect(decideFirstBoardPicker({ ...eligible, enabled: false, offline: true, timesShown: 2 })).toBe('kill_switch');
    });

    it('names the connection before the cap', () => {
      expect(decideFirstBoardPicker({ ...eligible, offline: true, timesShown: 2 })).toBe('offline');
    });
  });
});
