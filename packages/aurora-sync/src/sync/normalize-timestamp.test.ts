import { describe, expect, it } from 'vitest';
import { normalizeTimestamp } from './normalize-timestamp';

describe('normalizeTimestamp', () => {
  it('pins the naive space-separated Aurora form to UTC', () => {
    expect(normalizeTimestamp('2024-01-15 10:30:00')).toBe('2024-01-15T10:30:00.000Z');
  });

  it('truncates microseconds on the naive form', () => {
    expect(normalizeTimestamp('2024-01-15 10:30:00.123456')).toBe('2024-01-15T10:30:00.123Z');
  });

  it('passes already-qualified ISO strings through unchanged in meaning', () => {
    expect(normalizeTimestamp('2024-01-15T10:30:00Z')).toBe('2024-01-15T10:30:00.000Z');
    expect(normalizeTimestamp('2024-01-15T10:30:00+05:30')).toBe('2024-01-15T05:00:00.000Z');
  });

  // Aurora has never been observed to emit an explicit offset on the
  // space-separated form; these pin the defensive behaviour in case it does.
  it('respects a trailing ±hh:mm offset on the space-separated form (never relabels as UTC)', () => {
    expect(normalizeTimestamp('2024-01-15 10:30:00+05:30')).toBe('2024-01-15T05:00:00.000Z');
    expect(normalizeTimestamp('2024-01-15 10:30:00-05:30')).toBe('2024-01-15T16:00:00.000Z');
  });

  it('respects a compact trailing ±hhmm offset on the space-separated form', () => {
    expect(normalizeTimestamp('2024-01-15 10:30:00+0530')).toBe('2024-01-15T05:00:00.000Z');
    expect(normalizeTimestamp('2024-01-15 10:30:00-0530')).toBe('2024-01-15T16:00:00.000Z');
  });

  it('truncates microseconds sitting before a trailing offset', () => {
    expect(normalizeTimestamp('2024-01-15 10:30:00.123456+05:30')).toBe('2024-01-15T05:00:00.123Z');
  });

  it("does not mistake the date part's hyphens for an offset", () => {
    // "…-15" after the year/month hyphens must still be treated as naive UTC.
    expect(normalizeTimestamp('2024-01-15 10:30:00')).toBe('2024-01-15T10:30:00.000Z');
  });

  /**
   * TRIPWIRE (#3909). This asserts today's DELIBERATE decision: Aurora's naive
   * form is treated as UTC, and the result does not depend on the process's own
   * zone. If Marco settles open question 1 the other way — that the naive string
   * is the CLIMBER's local wall clock — this is the test that MUST change, and
   * every writer that funnels through normalizeTimestamp changes with it.
   */
  it('resolves the naive form to the same instant regardless of the process TZ (#3909)', () => {
    const originalTz = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Australia/Melbourne', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        expect(normalizeTimestamp('2024-01-15 10:30:00')).toBe('2024-01-15T10:30:00.000Z');
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
