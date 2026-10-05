import { describe, expect, it } from 'vitest';
import { isTickOnCurrentHolds, isTickOnEarlierVersion, knownClimbRevision } from '../tick-revision';

describe('knownClimbRevision', () => {
  it('keeps a positive integer', () => {
    expect(knownClimbRevision(1)).toBe(1);
    expect(knownClimbRevision(7)).toBe(7);
  });

  it('reads anything else as unknown', () => {
    for (const value of [null, undefined, 0, -1, 1.5, Number.NaN]) {
      expect(knownClimbRevision(value)).toBeNull();
    }
  });
});

describe('isTickOnCurrentHolds', () => {
  it('counts a tick at or above the version the holds last moved at', () => {
    expect(isTickOnCurrentHolds(3, 3)).toBe(true);
    expect(isTickOnCurrentHolds(4, 3)).toBe(true);
  });

  it('drops a tick logged before the holds moved', () => {
    expect(isTickOnCurrentHolds(2, 3)).toBe(false);
  });

  it('reads a tick with no version as version 1', () => {
    expect(isTickOnCurrentHolds(null, 1)).toBe(true);
    expect(isTickOnCurrentHolds(undefined, 2)).toBe(false);
  });

  it('reads a climb with no number as version 1, so every tick counts', () => {
    expect(isTickOnCurrentHolds(null, null)).toBe(true);
    expect(isTickOnCurrentHolds(1, undefined)).toBe(true);
    expect(isTickOnCurrentHolds(5, null)).toBe(true);
  });

  it('counts every tick on a climb whose holds never moved', () => {
    expect(isTickOnCurrentHolds(1, 1)).toBe(true);
    expect(isTickOnCurrentHolds(9, 1)).toBe(true);
  });
});

describe('isTickOnEarlierVersion', () => {
  it('is true when the tick is below the climb’s version', () => {
    expect(isTickOnEarlierVersion(1, 2)).toBe(true);
    expect(isTickOnEarlierVersion(2, 5)).toBe(true);
  });

  it('is false on the current version', () => {
    expect(isTickOnEarlierVersion(2, 2)).toBe(false);
    expect(isTickOnEarlierVersion(1, 1)).toBe(false);
  });

  it('is false when either number is unknown', () => {
    expect(isTickOnEarlierVersion(null, 4)).toBe(false);
    expect(isTickOnEarlierVersion(undefined, 4)).toBe(false);
    expect(isTickOnEarlierVersion(1, null)).toBe(false);
    expect(isTickOnEarlierVersion(1, undefined)).toBe(false);
  });

  it('is false for a tick that names a version ahead of the climb', () => {
    expect(isTickOnEarlierVersion(6, 4)).toBe(false);
  });
});
