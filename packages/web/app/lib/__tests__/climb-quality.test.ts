import { describe, expect, it } from 'vite-plus/test';
import { normalizedQuality } from '../climb-quality';

type QualityStats = Parameters<typeof normalizedQuality>[0];

const stats = (overrides: Partial<NonNullable<QualityStats>> = {}): QualityStats => ({
  quality_normalized: true,
  quality_average: '4.20',
  rating_count: '9',
  ...overrides,
});

describe('normalizedQuality', () => {
  it('returns the five-star average and the ratings behind it', () => {
    expect(normalizedQuality(stats())).toEqual({ average: 4.2, ratingCount: 9 });
  });

  it('counts whole ratings only', () => {
    expect(normalizedQuality(stats({ rating_count: '12.9' }))?.ratingCount).toBe(12);
  });

  it.each([
    ['no stats row', undefined],
    ['an Aurora-scale (1-3) average', stats({ quality_normalized: false })],
    ['no average', stats({ quality_average: null })],
    ['an average below the scale', stats({ quality_average: '0' })],
    ['an average above the scale', stats({ quality_average: '5.5' })],
    ['no ratings behind the average', stats({ rating_count: '0' })],
  ])('refuses %s', (_label, row) => {
    expect(normalizedQuality(row)).toBeNull();
  });
});
