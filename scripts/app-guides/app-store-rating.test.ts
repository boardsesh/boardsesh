import { describe, expect, it } from 'vite-plus/test';
import { APP_STORE_STOREFRONTS, aggregateRatings } from './app-store-rating';

describe('app store rating', () => {
  it('sums every rated storefront and weights the mean by count', () => {
    // The 2026-11-24 lookup: 17 storefronts with ratings, 72 in all.
    const perCountry = [
      ['us', 4.625, 32],
      ['ca', 4.77778, 9],
      ['au', 5, 6],
      ['gb', 4.2, 5],
      ['de', 5, 5],
      ['es', 5, 2],
      ['no', 5, 2],
      ['cn', 5, 2],
      ['nz', 5, 1],
      ['at', 4, 1],
      ['fr', 5, 1],
      ['be', 5, 1],
      ['nl', 5, 1],
      ['se', 5, 1],
      ['jp', 4, 1],
      ['mx', 5, 1],
      ['br', 5, 1],
      ['ie', 0, 0],
      ['it', 0, 0],
    ].map(([country, rating, count]) => ({ country: String(country), rating: Number(rating), count: Number(count) }));
    expect(aggregateRatings(perCountry)).toEqual({ rating: 4.722, count: 72, storefronts: 17 });
    expect(aggregateRatings([])).toEqual({ rating: 0, count: 0, storefronts: 0 });
  });

  it('asks every storefront once', () => {
    expect(new Set(APP_STORE_STOREFRONTS).size).toBe(APP_STORE_STOREFRONTS.length);
    expect(APP_STORE_STOREFRONTS).toEqual(expect.arrayContaining(['us', 'ca', 'au', 'gb', 'de', 'jp', 'br', 'no']));
  });
});
