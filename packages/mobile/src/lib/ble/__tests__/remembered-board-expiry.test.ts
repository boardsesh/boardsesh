import { describe, expect, it } from 'vitest';
import {
  HANG_UP_REMEMBER_MS,
  hasValidForgetAfter,
  isLockScreenTakeBack,
  isRememberedBoardExpired,
  soonestForgetAfter,
} from '../remembered-board-expiry';

// A hang-up keeps the board remembered for 10 minutes (plan item 2).

const kilter = { configKey: 'kilter::1::10::gym-kilter', serial: 'K-1' };
const moonboard = { configKey: 'moonboard::2::1::gym-moon', deviceId: 'moon-device' };

describe('HANG_UP_REMEMBER_MS', () => {
  it('is 10 minutes', () => {
    expect(HANG_UP_REMEMBER_MS).toBe(600_000);
  });
});

describe('isRememberedBoardExpired', () => {
  it('never expires a board kept with no stamp (a drop, a config switch, driving ending)', () => {
    expect(isRememberedBoardExpired(kilter, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('expires a stamped board from its stamp on, not a millisecond before', () => {
    const stamped = { ...kilter, forgetAfter: 1_000 };
    expect(isRememberedBoardExpired(stamped, 999)).toBe(false);
    expect(isRememberedBoardExpired(stamped, 1_000)).toBe(true);
    expect(isRememberedBoardExpired(stamped, 5_000)).toBe(true);
  });
});

describe('hasValidForgetAfter', () => {
  it.each([[undefined], [0], [1_800_000_000_000]])('accepts %s', (forgetAfter) => {
    expect(hasValidForgetAfter({ forgetAfter })).toBe(true);
  });

  it.each([['soon'], [Number.NaN], [Number.POSITIVE_INFINITY], [null]])('rejects %s', (forgetAfter) => {
    expect(hasValidForgetAfter({ forgetAfter })).toBe(false);
  });
});

describe('soonestForgetAfter', () => {
  it('is null when nothing is stamped', () => {
    expect(soonestForgetAfter([null, kilter, moonboard])).toBeNull();
  });

  it('picks the earliest stamp', () => {
    expect(soonestForgetAfter([{ ...kilter, forgetAfter: 9_000 }, null, { ...moonboard, forgetAfter: 4_000 }])).toBe(
      4_000,
    );
  });
});

describe('isLockScreenTakeBack', () => {
  const expired = { ...kilter, forgetAfter: 1_000 };

  it("takes back the Live Activity bulb's reconnect of this board", () => {
    expect(isLockScreenTakeBack('liveActivityIntent', kilter.configKey, expired)).toBe(true);
  });

  it('takes back no other origin: a state restoration, a JS connect, a binary that reports none', () => {
    expect(isLockScreenTakeBack('restored', kilter.configKey, expired)).toBe(false);
    expect(isLockScreenTakeBack('userConnect', kilter.configKey, expired)).toBe(false);
    expect(isLockScreenTakeBack(undefined, kilter.configKey, expired)).toBe(false);
  });

  it('takes back no reconnect of another board, or one with no pairing on record', () => {
    expect(isLockScreenTakeBack('liveActivityIntent', moonboard.configKey, expired)).toBe(false);
    expect(isLockScreenTakeBack('liveActivityIntent', undefined, expired)).toBe(false);
  });
});
