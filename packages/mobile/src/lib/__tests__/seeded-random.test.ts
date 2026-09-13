import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../seeded-random';

describe('mulberry32', () => {
  it('draws the same sequence twice from the same seed', () => {
    const first = mulberry32(12345);
    const second = mulberry32(12345);
    const drawnFirst = Array.from({ length: 20 }, () => first());
    const drawnSecond = Array.from({ length: 20 }, () => second());
    expect(drawnFirst).toEqual(drawnSecond);
  });

  it('starts a fresh sequence per generator, so call order between callers cannot matter', () => {
    const early = mulberry32(999);
    early();
    early();
    // A generator made later still begins at the start of the sequence.
    expect(mulberry32(999)()).toBe(mulberry32(999)());
  });

  it('draws a different sequence from a different seed', () => {
    const drawn = (seed: number) => Array.from({ length: 8 }, mulberry32(seed));
    expect(drawn(1)).not.toEqual(drawn(2));
  });

  it('stays inside [0, 1)', () => {
    const random = mulberry32(0);
    for (let draw = 0; draw < 500; draw += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('takes a seed of zero, which an xorshift could not', () => {
    const random = mulberry32(0);
    const drawn = Array.from({ length: 5 }, random);
    // Not a stuck generator: an all-zero state would repeat forever.
    expect(new Set(drawn).size).toBe(5);
  });
});
