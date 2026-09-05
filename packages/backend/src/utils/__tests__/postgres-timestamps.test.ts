import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePostgresUtcTimestamp } from '../postgres-timestamps';

// The naive-timestamp bug only shows up off UTC — on a UTC host the broken and
// the correct parse agree — so this file pins the process to +10 for its own
// duration and restores the original zone afterwards.
const PINNED_TIME_ZONE = 'Australia/Brisbane';

describe('parsePostgresUtcTimestamp', () => {
  const originalTimeZone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = PINNED_TIME_ZONE;
  });

  afterAll(() => {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  });

  it('pins the process to a non-UTC zone so the assertions below can fail', () => {
    // Guards the guard: if the runtime ignores a mid-process TZ change, every
    // other case here degrades into a tautology and we want to know.
    expect(new Date('2026-07-03T00:00:00.000Z').getHours()).toBe(10);
  });

  it('reads a naive Postgres timestamp as UTC rather than server-local time', () => {
    expect(parsePostgresUtcTimestamp('2026-07-03 10:00:00')).toBe('2026-07-03T10:00:00.000Z');
  });

  it('keeps fractional seconds on a naive timestamp', () => {
    expect(parsePostgresUtcTimestamp('2026-07-03 10:00:00.123')).toBe('2026-07-03T10:00:00.123Z');
  });

  it('leaves an already-zoned string on its own instant', () => {
    expect(parsePostgresUtcTimestamp('2026-07-03T10:00:00.000Z')).toBe('2026-07-03T10:00:00.000Z');
    expect(parsePostgresUtcTimestamp('2026-07-03T10:00:00+02:00')).toBe('2026-07-03T08:00:00.000Z');
  });

  it('passes a Date through as its UTC instant', () => {
    expect(parsePostgresUtcTimestamp(new Date(Date.UTC(2026, 6, 3, 10)))).toBe('2026-07-03T10:00:00.000Z');
  });

  it('returns null for a missing timestamp', () => {
    expect(parsePostgresUtcTimestamp(null)).toBeNull();
    expect(parsePostgresUtcTimestamp(undefined)).toBeNull();
    expect(parsePostgresUtcTimestamp('')).toBeNull();
  });

  it('returns null instead of throwing on an unparseable value', () => {
    // A corrupt or truncated column would otherwise reach `toISOString()` on an
    // Invalid Date and take down the whole aggregate with a RangeError.
    expect(parsePostgresUtcTimestamp('not-a-timestamp')).toBeNull();
    expect(parsePostgresUtcTimestamp('2026-13-45 99:99:99')).toBeNull();
    expect(parsePostgresUtcTimestamp(new Date('nope'))).toBeNull();
  });
});
