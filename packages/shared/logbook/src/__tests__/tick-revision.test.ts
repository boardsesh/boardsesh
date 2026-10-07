import { describe, expect, it } from 'vitest';
import { isTickOnCurrentHolds, knownClimbRevision } from '../tick-revision';

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

  it('reads a tick KNOWN to have no version (null) as version 1', () => {
    expect(isTickOnCurrentHolds(null, 1)).toBe(true);
    expect(isTickOnCurrentHolds(null, 2)).toBe(false);
  });

  it('counts a tick whose version is not known (undefined), whatever the holds version', () => {
    // The phone has no copy of the tick to ask. Reading it as version 1 would
    // turn a send on the current holds into "not sent" until the next pull.
    expect(isTickOnCurrentHolds(undefined, 1)).toBe(true);
    expect(isTickOnCurrentHolds(undefined, 2)).toBe(true);
    expect(isTickOnCurrentHolds(undefined, 9)).toBe(true);
  });

  it('reads a climb with no number as version 1, so every tick counts', () => {
    expect(isTickOnCurrentHolds(null, null)).toBe(true);
    expect(isTickOnCurrentHolds(1, undefined)).toBe(true);
    expect(isTickOnCurrentHolds(5, null)).toBe(true);
    expect(isTickOnCurrentHolds(undefined, undefined)).toBe(true);
  });

  it('counts every tick on a climb whose holds never moved', () => {
    expect(isTickOnCurrentHolds(1, 1)).toBe(true);
    expect(isTickOnCurrentHolds(9, 1)).toBe(true);
  });
});
