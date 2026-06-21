import { describe, expect, it } from 'vite-plus/test';
import {
  KILTER_HOMEWALL_LAYOUT_ID,
  KILTER_HOMEWALL_PRODUCT_ID,
  getLayoutName,
  isKilterHomewallTallSizeId,
  isKilterHomewallWideSizeId,
} from '../product-sizes';

describe('getLayoutName', () => {
  it('returns the human-readable name for a known board + layoutId', () => {
    expect(getLayoutName('kilter', 1)).toBe('Kilter Board Original');
  });

  it("returns '' for an unknown layoutId", () => {
    expect(getLayoutName('kilter', 99999)).toBe('');
  });
});

describe('Kilter Homewall identifiers', () => {
  it('pins the Aurora layout and product ids the filters key off', () => {
    expect(KILTER_HOMEWALL_LAYOUT_ID).toBe(8);
    expect(KILTER_HOMEWALL_PRODUCT_ID).toBe(7);
  });
});

describe('Kilter Homewall size filter capabilities', () => {
  it('marks 8x12 and 10x12 Homewall sizes as tall-capable', () => {
    for (const sizeId of [23, 24, 25, 26]) {
      expect(isKilterHomewallTallSizeId(sizeId)).toBe(true);
    }
  });

  it('does not mark 10-high Homewall sizes as tall-capable', () => {
    for (const sizeId of [17, 18, 21, 22, 29]) {
      expect(isKilterHomewallTallSizeId(sizeId)).toBe(false);
    }
  });

  it('keeps 8x12 Homewall sizes out of the wide-climbs filter', () => {
    for (const sizeId of [23, 24]) {
      expect(isKilterHomewallWideSizeId(sizeId)).toBe(false);
    }
  });
});
