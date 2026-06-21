import { describe, it, expect } from 'vite-plus/test';
import {
  getSizeFullnessTiers,
  fullnessFactor,
  FULLNESS_FULL,
  FULLNESS_NARROWER,
  FULLNESS_SHORTER,
} from '../size-comparison';

// Kilter Homewall (product 7): 7x10 = 17/18/19 (h120 w88), 10x10 = 21/22/29
// (h120 w112), 8x12 = 23/24 (h156 w88), 10x12 = 25/26 (h156 w112).

describe('getSizeFullnessTiers — 10x12 (id 25)', () => {
  const tiers = getSizeFullnessTiers('kilter', 25);

  it('treats 7x10 and 10x10 as shorter (less height)', () => {
    expect(tiers.shorterSizeIds).toEqual(expect.arrayContaining([17, 18, 19, 21, 22, 29]));
  });

  it('treats 8x12 as same-height-narrower', () => {
    expect(tiers.narrowerSameHeightSizeIds).toEqual(expect.arrayContaining([23, 24]));
    expect(tiers.narrowerSameHeightSizeIds).not.toContain(17);
  });

  it('does not pull in commercial-product sizes (different coordinate frame)', () => {
    expect(tiers.shorterSizeIds).not.toContain(10); // 12x12 commercial (product 1)
    expect(tiers.shorterSizeIds).not.toContain(20); // 10x12 product 4
  });
});

describe('fullnessFactor — 10x12 owner', () => {
  const tiers = getSizeFullnessTiers('kilter', 25);

  it('ranks a 7x10-fitting climb lowest (uses less height)', () => {
    expect(fullnessFactor([17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29], tiers)).toBe(FULLNESS_SHORTER);
  });

  it('ranks a full-height-but-narrow (8x12) climb in the middle', () => {
    expect(fullnessFactor([20, 23, 24, 25, 26], tiers)).toBe(FULLNESS_NARROWER);
  });

  it('ranks a 10x12-only (kickboard) climb highest', () => {
    expect(fullnessFactor([20, 25, 26], tiers)).toBe(FULLNESS_FULL);
  });
});

describe('fullnessFactor — 10x10 owner (id 21)', () => {
  const tiers = getSizeFullnessTiers('kilter', 21);

  it('has no shorter tier (nothing in the home line is shorter than 10x10)', () => {
    expect(tiers.shorterSizeIds).toHaveLength(0);
  });

  it('is open to 7x10 climbs but ranks them just below full-width (no height lost)', () => {
    expect(fullnessFactor([17, 18, 19, 21, 22, 29], tiers)).toBe(FULLNESS_NARROWER);
  });

  it('ranks a full-width 10x10 climb highest', () => {
    expect(fullnessFactor([20, 21, 22, 25, 26, 29], tiers)).toBe(FULLNESS_FULL);
  });
});
