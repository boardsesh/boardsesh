import { describe, it, expect } from 'vitest';
import { sanitizeFirstAscent, FIRST_ASCENT_EARLIEST_MS } from './sanitize-first-ascent';

const NOW = new Date('2026-07-31T00:00:00.000Z');

describe('sanitizeFirstAscent', () => {
  it('nulls both fields for a future date (e.g. upstream 2033 garbage)', () => {
    expect(sanitizeFirstAscent({ faUsername: 'someone', faAt: '2033-01-01T00:00:00.000Z' }, NOW)).toEqual({
      faUsername: null,
      faAt: null,
    });
  });

  it('nulls both fields for a pre-launch date (before any board existed)', () => {
    expect(sanitizeFirstAscent({ faUsername: 'someone', faAt: '2006-01-01T00:00:00.000Z' }, NOW)).toEqual({
      faUsername: null,
      faAt: null,
    });
  });

  it('passes through the exact earliest-allowed boundary', () => {
    const fields = { faUsername: 'someone', faAt: new Date(FIRST_ASCENT_EARLIEST_MS).toISOString() };
    expect(sanitizeFirstAscent(fields, NOW)).toEqual(fields);
  });

  it('nulls one millisecond before the earliest-allowed boundary', () => {
    const oneMsBefore = new Date(FIRST_ASCENT_EARLIEST_MS - 1).toISOString();
    expect(sanitizeFirstAscent({ faUsername: 'someone', faAt: oneMsBefore }, NOW)).toEqual({
      faUsername: null,
      faAt: null,
    });
  });

  it('passes through the current moment (no clock skew)', () => {
    const fields = { faUsername: 'someone', faAt: NOW.toISOString() };
    expect(sanitizeFirstAscent(fields, NOW)).toEqual(fields);
  });

  it('nulls a date more than the one-day clock-skew grace window in the future', () => {
    const twoDaysAhead = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(sanitizeFirstAscent({ faUsername: 'someone', faAt: twoDaysAhead }, NOW)).toEqual({
      faUsername: null,
      faAt: null,
    });
  });

  it('nulls both fields for an unparseable date string', () => {
    expect(sanitizeFirstAscent({ faUsername: 'someone', faAt: 'not-a-date' }, NOW)).toEqual({
      faUsername: null,
      faAt: null,
    });
  });

  it('passes a null faAt through unchanged even with a present faUsername', () => {
    // Documents that the FA/count-contradiction case (null faAt alongside a
    // faUsername, or vice versa) is explicitly out of scope for this fix.
    const fields = { faUsername: 'someone', faAt: null };
    expect(sanitizeFirstAscent(fields, NOW)).toEqual(fields);
  });

  it('preserves a valid recent fa_at and fa_username verbatim, without reformatting', () => {
    const fields = { faUsername: 'climber123', faAt: '2024-03-15T12:34:56.000Z' };
    expect(sanitizeFirstAscent(fields, NOW)).toEqual(fields);
    expect(sanitizeFirstAscent(fields, NOW).faAt).toBe('2024-03-15T12:34:56.000Z');
  });
});
