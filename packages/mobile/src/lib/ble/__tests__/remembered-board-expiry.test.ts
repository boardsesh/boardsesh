import { describe, expect, it } from 'vitest';
import {
  HANG_UP_REMEMBER_MS,
  hasValidForgetAfter,
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
