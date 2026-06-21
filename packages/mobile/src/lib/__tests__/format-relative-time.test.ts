import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { formatRelativeTime, compactAgoParts } from '../format-relative-time';

describe('formatRelativeTime', () => {
  // Pin "now" so the relative deltas are deterministic.
  const NOW = new Date('2026-06-04T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns an empty string for missing or unparseable input', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime(undefined)).toBe('');
    expect(formatRelativeTime('')).toBe('');
    expect(formatRelativeTime('not-a-date')).toBe('');
  });

  it('formats sub-minute deltas', () => {
    expect(formatRelativeTime(ago(5_000))).toBe('a few seconds ago');
  });

  it('rolls up to minutes, hours, and days', () => {
    expect(formatRelativeTime(ago(5 * 60_000))).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(3 * 3_600_000))).toBe('3 hours ago');
    expect(formatRelativeTime(ago(2 * 86_400_000))).toBe('2 days ago');
  });

  it('rolls up to months and years past the day/month thresholds', () => {
    expect(formatRelativeTime(ago(60 * 86_400_000))).toBe('2 months ago');
    expect(formatRelativeTime(ago(400 * 86_400_000))).toBe('a year ago');
  });

  it('parses naive DB timestamps (no Z suffix) as UTC', () => {
    // Draft created_at comes from naive timestamp columns; Drizzle returns them
    // without a timezone marker and they must be read as UTC.
    expect(formatRelativeTime('2026-06-04 11:55:00')).toBe('5 minutes ago');
  });

  it('honours the offset on Z-suffixed timestamps (the BLE picker passes these)', () => {
    expect(formatRelativeTime('2026-06-04T11:55:00.000Z')).toBe('5 minutes ago');
  });

  it('works without Intl.RelativeTimeFormat, like Hermes on device', () => {
    // Regression test for the TestFlight drafts crash: Hermes ships an
    // incomplete Intl (no RelativeTimeFormat), while Node — where these tests
    // run — has the full implementation, so a direct Intl dependency passes CI
    // and then hard-crashes release builds.
    const intlWithoutRelativeTimeFormat = Object.create(
      Object.getPrototypeOf(Intl),
      Object.getOwnPropertyDescriptors(Intl),
    ) as Record<string, unknown>;
    delete intlWithoutRelativeTimeFormat.RelativeTimeFormat;
    vi.stubGlobal('Intl', intlWithoutRelativeTimeFormat);
    try {
      expect(formatRelativeTime(ago(5 * 60_000))).toBe('5 minutes ago');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('compactAgoParts', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const NOW = 1_700_000_000_000;

  it('buckets sub-minute durations as "now"', () => {
    expect(compactAgoParts(NOW - 30_000, NOW)).toEqual({ unit: 'now', count: 0 });
    expect(compactAgoParts(NOW, NOW)).toEqual({ unit: 'now', count: 0 });
  });

  it('buckets minutes, hours, days and weeks with a floored count', () => {
    expect(compactAgoParts(NOW - 5 * MIN, NOW)).toEqual({ unit: 'minutes', count: 5 });
    expect(compactAgoParts(NOW - 59 * MIN, NOW)).toEqual({ unit: 'minutes', count: 59 });
    expect(compactAgoParts(NOW - (2 * HOUR + 30 * MIN), NOW)).toEqual({ unit: 'hours', count: 2 });
    expect(compactAgoParts(NOW - 3 * DAY, NOW)).toEqual({ unit: 'days', count: 3 });
    expect(compactAgoParts(NOW - 2 * WEEK, NOW)).toEqual({ unit: 'weeks', count: 2 });
  });

  it('crosses each boundary at the expected threshold', () => {
    expect(compactAgoParts(NOW - 60 * MIN, NOW)).toEqual({ unit: 'hours', count: 1 });
    expect(compactAgoParts(NOW - 24 * HOUR, NOW)).toEqual({ unit: 'days', count: 1 });
    expect(compactAgoParts(NOW - 7 * DAY, NOW)).toEqual({ unit: 'weeks', count: 1 });
  });

  it('clamps a future timestamp (clock skew) to "now"', () => {
    expect(compactAgoParts(NOW + 5 * MIN, NOW)).toEqual({ unit: 'now', count: 0 });
  });
});
