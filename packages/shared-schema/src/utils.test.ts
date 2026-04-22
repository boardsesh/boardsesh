import { describe, it, expect } from 'vitest';
import { convertQuality } from './utils.ts';

describe('convertQuality', () => {
  it('returns null for null or undefined input', () => {
    expect(convertQuality(null)).toBeNull();
    expect(convertQuality(undefined)).toBeNull();
  });

  it('returns null for 0 (Aurora "unrated" sentinel)', () => {
    expect(convertQuality(0)).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(convertQuality(-1)).toBeNull();
    expect(convertQuality(-0.5)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(convertQuality(NaN)).toBeNull();
  });

  it('maps Aurora endpoints exactly (1 -> 1, 3 -> 5)', () => {
    expect(convertQuality(1)).toBe(1);
    expect(convertQuality(3)).toBe(5);
  });

  it('maps Aurora 2 to the middle of the 1-5 scale (3)', () => {
    expect(convertQuality(2)).toBe(3);
  });

  it('clamps values above 3 to the top of the 1-5 scale', () => {
    expect(convertQuality(4)).toBe(5);
    expect(convertQuality(5)).toBe(5);
    expect(convertQuality(100)).toBe(5);
  });

  it('rounds continuous intermediate values', () => {
    // (1.5 - 1) / 2 * 4 + 1 = 2
    expect(convertQuality(1.5)).toBe(2);
    // (2.5 - 1) / 2 * 4 + 1 = 4
    expect(convertQuality(2.5)).toBe(4);
  });

  it('accepts numeric strings via Number() coercion', () => {
    expect(convertQuality('3' as unknown as number)).toBe(5);
    expect(convertQuality('1' as unknown as number)).toBe(1);
  });
});
