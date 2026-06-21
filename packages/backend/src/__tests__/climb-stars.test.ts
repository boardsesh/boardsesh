import { describe, expect, it } from 'vite-plus/test';
import { getClimbStars } from '@boardsesh/db/queries';

describe('getClimbStars', () => {
  it('maps the canonical 1-5 quality average straight to a 0-5 star count', () => {
    expect(getClimbStars(3)).toBe(3);
    expect(getClimbStars('2.4')).toBe(2);
    expect(getClimbStars(4.5)).toBe(5);
    expect(getClimbStars('4.2')).toBe(4);
    expect(getClimbStars(5)).toBe(5);
  });

  it('caps out-of-range ratings at 5 stars', () => {
    expect(getClimbStars(8)).toBe(5);
    expect(getClimbStars('5.6')).toBe(5);
  });

  it('treats unrated climbs as zero stars', () => {
    expect(getClimbStars(0)).toBe(0);
    expect(getClimbStars(-1)).toBe(0);
    expect(getClimbStars(null)).toBe(0);
    expect(getClimbStars('not-a-number')).toBe(0);
  });
});
