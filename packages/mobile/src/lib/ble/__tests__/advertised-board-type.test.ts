import { describe, expect, it } from 'vitest';
import {
  advertisedBoardTypesBySerial,
  matchesAdvertisedType,
  sharedAdvertisedBoardType,
} from '../advertised-board-type';

/**
 * The single source of the "a serial identifies a controller only within a board
 * type" rule. Aurora numbers each board app separately, so a Kilter `#12345` and
 * a Tension `#12345` are different hardware — reported from Benchmark Climbing,
 * where a Tension controller resolved onto a stranger's Kilter board.
 *
 * Both surfaces that turn scan results into boards read this module (the
 * connect-time picker via resolve-serials.ts, the quickstart sheet via
 * useBoardsBySerialNumbers), so it is where the rule gets pinned.
 */
describe('advertisedBoardTypesBySerial', () => {
  it('keys each device name by its serial and board type', () => {
    const advertisedTypes = advertisedBoardTypesBySerial([
      { name: 'Tension Board#12345@3' },
      { name: 'Kilter Board#99@3' },
    ]);

    expect([...advertisedTypes]).toEqual([
      ['12345', 'tension'],
      ['99', 'kilter'],
    ]);
  });

  it('omits a name with no recognisable board type', () => {
    expect(advertisedBoardTypesBySerial([{ name: 'Mystery Box#12345@3' }, {}]).size).toBe(0);
  });

  it('keeps the first sighting when a serial is advertised twice', () => {
    // Two boxes in range genuinely claiming one serial is a supplier fault we
    // can't adjudicate here; take the first and stay deterministic.
    const advertisedTypes = advertisedBoardTypesBySerial([
      { name: 'Tension Board#12345@3' },
      { name: 'Kilter Board#12345@3' },
    ]);

    expect(advertisedTypes.get('12345')).toBe('tension');
  });
});

describe('sharedAdvertisedBoardType', () => {
  it('returns the type when the whole scan agrees', () => {
    expect(sharedAdvertisedBoardType(new Map([['1', 'tension']]))).toBe('tension');
    expect(
      sharedAdvertisedBoardType(
        new Map([
          ['1', 'tension'],
          ['2', 'tension'],
        ]),
      ),
    ).toBe('tension');
  });

  it('returns undefined for a mixed scan so the request goes out unscoped', () => {
    // One argument can't describe two types; the per-serial filter takes over.
    expect(
      sharedAdvertisedBoardType(
        new Map([
          ['1', 'tension'],
          ['2', 'kilter'],
        ]),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when nothing advertised a type', () => {
    expect(sharedAdvertisedBoardType(new Map())).toBeUndefined();
  });
});

describe('matchesAdvertisedType', () => {
  const advertisedTypes = new Map([['12345', 'tension']]);

  it('rejects a board of a different type', () => {
    expect(matchesAdvertisedType('12345', 'kilter', advertisedTypes)).toBe(false);
  });

  it('accepts a board of the advertised type', () => {
    expect(matchesAdvertisedType('12345', 'tension', advertisedTypes)).toBe(true);
  });

  it('accepts when either side is unknown', () => {
    // Permissive on purpose: an unknown type is not evidence of a mismatch, and
    // dropping the match would lose a board the picker could otherwise name.
    expect(matchesAdvertisedType('99', 'kilter', advertisedTypes)).toBe(true);
    expect(matchesAdvertisedType('12345', undefined, advertisedTypes)).toBe(true);
    expect(matchesAdvertisedType('12345', null, advertisedTypes)).toBe(true);
  });
});
