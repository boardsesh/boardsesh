import { describe, it, expect } from 'vite-plus/test';
import { formatCount, formatSends, formatQuality } from '@/app/lib/format-climb-stats';

describe('formatCount', () => {
  it('returns raw number below 1000', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1)).toBe('1');
    expect(formatCount(378)).toBe('378');
    expect(formatCount(999)).toBe('999');
  });

  it('formats 1000–9999 with 1 decimal + k', () => {
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(1900)).toBe('1.9k');
    expect(formatCount(2500)).toBe('2.5k');
    expect(formatCount(9499)).toBe('9.5k');
  });

  it('handles the boundary without showing 10.0k', () => {
    expect(formatCount(9950)).toBe('9.9k');
    expect(formatCount(9960)).toBe('10k');
    expect(formatCount(9999)).toBe('10k');
  });

  it('formats ≥10000 as rounded integer + k', () => {
    expect(formatCount(10000)).toBe('10k');
    expect(formatCount(13200)).toBe('13k');
    expect(formatCount(13800)).toBe('14k');
    expect(formatCount(100000)).toBe('100k');
    expect(formatCount(999499)).toBe('999k');
  });

  it('formats ≥1000000 with 1 decimal + m', () => {
    expect(formatCount(1000000)).toBe('1m');
    expect(formatCount(1400000)).toBe('1.4m');
    expect(formatCount(2500000)).toBe('2.5m');
    expect(formatCount(10000000)).toBe('10m');
    expect(formatCount(15300000)).toBe('15.3m');
  });
});

describe('formatSends', () => {
  // Fake translate mirroring the en-US `sends` plural key shape, so these cases
  // pin what `formatSends` HANDS the catalog — the true count for plural
  // selection, the compact string for display — rather than the catalog itself.
  const t = (_key: string, options: { count: number; formattedCount: string }) =>
    `${options.formattedCount} send${options.count === 1 ? '' : 's'}`;

  it('passes the true count for plural selection, so 1 stays singular', () => {
    expect(formatSends(1, t)).toBe('1 send');
  });

  it('uses plural for counts other than 1', () => {
    expect(formatSends(0, t)).toBe('0 sends');
    expect(formatSends(2, t)).toBe('2 sends');
    expect(formatSends(999, t)).toBe('999 sends');
  });

  it('hands the catalog the compact count, not the raw one', () => {
    expect(formatSends(1000, t)).toBe('1k sends');
    expect(formatSends(1500000, t)).toBe('1.5m sends');
  });

  it('asks for the `sends` key in the climbs namespace', () => {
    expect(formatSends(3, (key) => key)).toBe('sends');
  });
});

describe('formatQuality', () => {
  it('rounds to 1 decimal place', () => {
    expect(formatQuality('2.666')).toBe('2.7');
    expect(formatQuality('3.0')).toBe('3.0');
    expect(formatQuality('4.56')).toBe('4.6');
    expect(formatQuality('1')).toBe('1.0');
  });

  it('returns original string for non-numeric input', () => {
    expect(formatQuality('abc')).toBe('abc');
    expect(formatQuality('')).toBe('');
  });
});
