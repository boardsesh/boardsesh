import { describe, it, expect } from 'vitest';
import { formatCount, formatSends, formatQuality } from '../format-climb-stats';

describe('formatCount', () => {
  it('returns the number as a string for counts below 1000', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1)).toBe('1');
    expect(formatCount(999)).toBe('999');
  });

  it('formats thousands with one decimal for small thousands', () => {
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(9960)).toBe('10k');
  });

  it('rounds large thousands to nearest integer', () => {
    expect(formatCount(10000)).toBe('10k');
    expect(formatCount(15000)).toBe('15k');
    expect(formatCount(999000)).toBe('999k');
  });

  it('formats millions with one decimal', () => {
    expect(formatCount(1_000_000)).toBe('1m');
    expect(formatCount(1_500_000)).toBe('1.5m');
    expect(formatCount(2_300_000)).toBe('2.3m');
  });
});

describe('formatSends', () => {
  // Fake translate mirroring the en-US `sends` plural key shape.
  const t = (_key: string, o: { count: number; formattedCount: string }) =>
    `${o.formattedCount} send${o.count === 1 ? '' : 's'}`;

  it('passes the true count for plural selection (singular for 1)', () => {
    expect(formatSends(1, t)).toBe('1 send');
  });

  it('uses plural and the compact formatted count', () => {
    expect(formatSends(5, t)).toBe('5 sends');
    expect(formatSends(0, t)).toBe('0 sends');
    expect(formatSends(1500, t)).toBe('1.5k sends');
  });
});

describe('formatQuality', () => {
  it('rounds to one decimal place', () => {
    expect(formatQuality('3.456')).toBe('3.5');
    expect(formatQuality('4.0')).toBe('4.0');
    expect(formatQuality('2.95')).toBe('3.0');
  });

  it('returns the input for non-numeric strings', () => {
    expect(formatQuality('abc')).toBe('abc');
  });
});
