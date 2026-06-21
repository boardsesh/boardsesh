// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { describe, it, expect } from 'vite-plus/test';
import { normalizeIanaTimezone, utcIsoToLocalWallClock } from '../utils/timezone';

describe('normalizeIanaTimezone', () => {
  it('accepts known IANA zones', () => {
    expect(normalizeIanaTimezone('Australia/Melbourne')).toBe('Australia/Melbourne');
    expect(normalizeIanaTimezone(' America/New_York ')).toBe('America/New_York');
    expect(normalizeIanaTimezone('UTC')).toBe('UTC');
  });

  it('rejects junk without throwing', () => {
    expect(normalizeIanaTimezone('Not/AZone')).toBeNull();
    expect(normalizeIanaTimezone('')).toBeNull();
    expect(normalizeIanaTimezone('x'.repeat(65))).toBeNull();
    expect(normalizeIanaTimezone(null)).toBeNull();
    expect(normalizeIanaTimezone(42)).toBeNull();
  });
});

describe('utcIsoToLocalWallClock', () => {
  it('converts a UTC instant to wall-clock local time in the zone', () => {
    // 15:00 UTC in January is 10:00 in New York (EST, UTC-5).
    expect(utcIsoToLocalWallClock('2026-01-15T15:00:00.000Z', 'America/New_York')).toBe('2026-01-15T10:00:00');
    // 15:00 UTC in January is 02:00 NEXT DAY in Melbourne (AEDT, UTC+11) —
    // the date component must roll, not just the hours.
    expect(utcIsoToLocalWallClock('2026-01-15T15:00:00.000Z', 'Australia/Melbourne')).toBe('2026-01-16T02:00:00');
  });

  it('respects daylight saving on the instant, not today', () => {
    // July in New York is EDT (UTC-4).
    expect(utcIsoToLocalWallClock('2026-07-15T15:00:00.000Z', 'America/New_York')).toBe('2026-07-15T11:00:00');
  });

  it('falls back to the input for missing or invalid zones', () => {
    expect(utcIsoToLocalWallClock('2026-01-15T15:00:00.000Z', null)).toBe('2026-01-15T15:00:00.000Z');
    expect(utcIsoToLocalWallClock('2026-01-15T15:00:00.000Z', undefined)).toBe('2026-01-15T15:00:00.000Z');
    expect(utcIsoToLocalWallClock('2026-01-15T15:00:00.000Z', 'Not/AZone')).toBe('2026-01-15T15:00:00.000Z');
    expect(utcIsoToLocalWallClock('not-a-date', 'America/New_York')).toBe('not-a-date');
  });
});
