import { describe, it, expect } from 'vitest';
import {
  CLIMB_CHARACTERISTICS,
  hasCharacteristic,
  isNoMatch,
  getMoonBoardMethod,
  withCharacteristic,
  isMethodCharacteristic,
  moonBoardMethodToCharacteristic,
} from '../characteristics';

describe('hasCharacteristic / isNoMatch', () => {
  it('detects a present token', () => {
    expect(hasCharacteristic(['no_match'], CLIMB_CHARACTERISTICS.NO_MATCH)).toBe(true);
    expect(hasCharacteristic(['method_footless'], CLIMB_CHARACTERISTICS.NO_MATCH)).toBe(false);
  });

  it('handles null/undefined/empty', () => {
    expect(isNoMatch(null)).toBe(false);
    expect(isNoMatch(undefined)).toBe(false);
    expect(isNoMatch([])).toBe(false);
    expect(isNoMatch(['no_match'])).toBe(true);
  });
});

describe('getMoonBoardMethod', () => {
  it('returns the single method token, or null for the default', () => {
    expect(getMoonBoardMethod(['method_footless'])).toBe('method_footless');
    expect(getMoonBoardMethod(['no_match', 'method_footless_kickboard'])).toBe('method_footless_kickboard');
    expect(getMoonBoardMethod(['no_match'])).toBeNull();
    expect(getMoonBoardMethod([])).toBeNull();
    expect(getMoonBoardMethod(null)).toBeNull();
  });
});

describe('isMethodCharacteristic', () => {
  it('only the method_* tokens are methods', () => {
    expect(isMethodCharacteristic('method_footless')).toBe(true);
    expect(isMethodCharacteristic('method_no_kickboard')).toBe(true);
    expect(isMethodCharacteristic('no_match')).toBe(false);
  });
});

describe('withCharacteristic', () => {
  it('adds and removes a non-method token without touching others', () => {
    expect(withCharacteristic(['method_footless'], CLIMB_CHARACTERISTICS.NO_MATCH, true)).toEqual([
      'method_footless',
      'no_match',
    ]);
    expect(withCharacteristic(['method_footless', 'no_match'], CLIMB_CHARACTERISTICS.NO_MATCH, false)).toEqual([
      'method_footless',
    ]);
  });

  it('is idempotent', () => {
    expect(withCharacteristic(['no_match'], CLIMB_CHARACTERISTICS.NO_MATCH, true)).toEqual(['no_match']);
    expect(withCharacteristic([], CLIMB_CHARACTERISTICS.NO_MATCH, false)).toEqual([]);
  });

  it('enables a method token by clearing any sibling method (mutual exclusivity)', () => {
    expect(
      withCharacteristic(['no_match', 'method_footless'], CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD, true),
    ).toEqual(['no_match', 'method_footless_kickboard']);
  });

  it('handles null/undefined input', () => {
    expect(withCharacteristic(null, CLIMB_CHARACTERISTICS.NO_MATCH, true)).toEqual(['no_match']);
    expect(withCharacteristic(undefined, CLIMB_CHARACTERISTICS.METHOD_FOOTLESS, true)).toEqual(['method_footless']);
  });
});

describe('moonBoardMethodToCharacteristic', () => {
  it('maps known method strings, case/punctuation-insensitively', () => {
    expect(moonBoardMethodToCharacteristic('Footless')).toBe('method_footless');
    expect(moonBoardMethodToCharacteristic('Footless + kickboard')).toBe('method_footless_kickboard');
    expect(moonBoardMethodToCharacteristic('footless+kickboard')).toBe('method_footless_kickboard');
    expect(moonBoardMethodToCharacteristic('No kickboard')).toBe('method_no_kickboard');
    expect(moonBoardMethodToCharacteristic('no-kickboard')).toBe('method_no_kickboard');
  });

  it('maps the default and unknowns to null', () => {
    expect(moonBoardMethodToCharacteristic('Feet follow hands')).toBeNull();
    expect(moonBoardMethodToCharacteristic('')).toBeNull();
    expect(moonBoardMethodToCharacteristic(null)).toBeNull();
    expect(moonBoardMethodToCharacteristic(undefined)).toBeNull();
    expect(moonBoardMethodToCharacteristic('Screw ons only')).toBeNull();
  });

  it('treats a "no kickboard" qualifier as negating the kickboard half', () => {
    // Footless WITH the kickboard → the combined token.
    expect(moonBoardMethodToCharacteristic('footless + kickboard allowed')).toBe('method_footless_kickboard');
    // Footless but explicitly NO kickboard → plain footless, not the combined token.
    expect(moonBoardMethodToCharacteristic('Footless, no kickboard')).toBe('method_footless');
    // "no kickboard" without footless → the no-kickboard token.
    expect(moonBoardMethodToCharacteristic('Feet follow hands, no kickboard')).toBe('method_no_kickboard');
  });

  // The canonical method labels the MoonBoard app surfaces, which appear verbatim
  // as `.data[].method` in the community dump (the import call site:
  // packages/db/scripts/import-moonboard-problems.ts). Locking them here documents
  // the contract for each. NOTE: a full sweep of every *distinct* `.method` value
  // across all six layout JSONs in the dump is deferred — the mapper is
  // substring-based (see characteristics.ts:88-91) so minor label variants still
  // resolve, but extending it should re-confirm against that authoritative set.
  it.each([
    ['Feet follow hands', null],
    ['Footless', 'method_footless'],
    ['Footless + kickboard', 'method_footless_kickboard'],
    ['No kickboard', 'method_no_kickboard'],
  ])('maps the canonical MoonBoard label %j to %j', (label, expected) => {
    expect(moonBoardMethodToCharacteristic(label as string)).toBe(expected);
  });
});
