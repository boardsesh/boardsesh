import { describe, it, expect } from 'vitest';
import { parseQueueTimestamp, queueTimestampAgeDays } from '../queue-timestamps';

describe('parseQueueTimestamp', () => {
  // The exact epoch matters, not just "not null": SQLite's datetime('now')
  // format has a SPACE separator and no zone, so a naive `Date.parse` is
  // implementation-defined — V8 accepts it and Hermes does not. Asserting the
  // number is what proves the normalisation, and that the value is read as UTC
  // rather than the device's local time.
  it('parses the SQLite datetime() shape as UTC', () => {
    expect(parseQueueTimestamp('2026-08-12 10:00:00')).toBe(Date.UTC(2026, 7, 12, 10, 0, 0));
  });

  it('passes an already-ISO value through to the same epoch', () => {
    expect(parseQueueTimestamp('2026-08-12T10:00:00Z')).toBe(Date.UTC(2026, 7, 12, 10, 0, 0));
  });

  it('respects an explicit offset instead of stamping Z on top of it', () => {
    expect(parseQueueTimestamp('2026-08-12T12:00:00+02:00')).toBe(Date.UTC(2026, 7, 12, 10, 0, 0));
  });

  it.each([null, undefined, '', '   ', 'not a date'])('returns null for %p', (value) => {
    expect(parseQueueTimestamp(value)).toBeNull();
  });
});

describe('queueTimestampAgeDays', () => {
  it('floors whole days since the timestamp', () => {
    const now = Date.UTC(2026, 7, 12, 10, 0, 0);
    expect(queueTimestampAgeDays('2026-08-09 10:00:01', now)).toBe(2);
    expect(queueTimestampAgeDays('2026-08-09 10:00:00', now)).toBe(3);
  });

  it('returns null rather than 0 when the timestamp is unusable', () => {
    expect(queueTimestampAgeDays(null)).toBeNull();
  });
});
