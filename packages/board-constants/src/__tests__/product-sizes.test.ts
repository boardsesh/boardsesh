import { describe, expect, it } from 'vite-plus/test';
import { getLayoutName, isKilterHomewallTallSizeId, isKilterHomewallWideSizeId } from '../product-sizes';

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

describe('getLayoutName', () => {
  it('resolves a known board + layout id to its human-readable name', () => {
    expect(getLayoutName('kilter', 1)).toBe('Kilter Board Original');
    expect(getLayoutName('tension', 9)).toBe('Original Layout');
  });

  it('returns an empty string for an unknown layout id', () => {
    expect(getLayoutName('kilter', 99999)).toBe('');
  });
});
