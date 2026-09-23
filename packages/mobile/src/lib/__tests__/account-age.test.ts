import { describe, expect, it } from 'vitest';
import { accountAgeHours, accountAgeMs } from '../account-age';

const AT = Date.parse('2026-09-21T08:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function isoBefore(ageMs: number): string {
  return new Date(AT - ageMs).toISOString();
}

describe('accountAgeMs', () => {
  it('measures from creation to the given moment', () => {
    expect(accountAgeMs(isoBefore(90_000), AT)).toBe(90_000);
  });

  it('floors a creation time ahead of the phone clock at zero', () => {
    expect(accountAgeMs(isoBefore(-5 * 60_000), AT)).toBe(0);
  });

  it('is null when the creation time is missing or unreadable', () => {
    expect(accountAgeMs(null, AT)).toBeNull();
    expect(accountAgeMs(undefined, AT)).toBeNull();
    expect(accountAgeMs('', AT)).toBeNull();
    expect(accountAgeMs('not a date', AT)).toBeNull();
  });
});

describe('accountAgeHours', () => {
  it('counts whole hours, rounded down, so the 24 h and 7-day lines never move by one', () => {
    expect(accountAgeHours(isoBefore(59 * 60_000), AT)).toBe(0);
    expect(accountAgeHours(isoBefore(HOUR_MS), AT)).toBe(1);
    expect(accountAgeHours(isoBefore(24 * HOUR_MS - 1), AT)).toBe(23);
    expect(accountAgeHours(isoBefore(24 * HOUR_MS), AT)).toBe(24);
    expect(accountAgeHours(isoBefore(7 * 24 * HOUR_MS - 60_000), AT)).toBe(167);
  });

  it('is zero for a creation time ahead of the phone clock', () => {
    expect(accountAgeHours(isoBefore(-5 * 60_000), AT)).toBe(0);
  });

  it('is null when the creation time is unknown', () => {
    expect(accountAgeHours(null, AT)).toBeNull();
    expect(accountAgeHours('not a date', AT)).toBeNull();
  });
});
