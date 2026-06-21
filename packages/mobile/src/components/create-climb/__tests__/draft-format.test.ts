import { describe, it, expect } from 'vitest';
import { countHolds } from '../draft-format';

describe('countHolds', () => {
  it('counts each p{id}r{code} token', () => {
    expect(countHolds('p1080r15p1140r12p1188r13')).toBe(3);
    expect(countHolds('p5r1')).toBe(1);
  });

  it('returns 0 for an empty or token-free string', () => {
    expect(countHolds('')).toBe(0);
    expect(countHolds('not a frames string')).toBe(0);
  });

  it('returns 0 for null or undefined frames', () => {
    // The Climb type says frames is a string, but a stale cache or edge-case
    // response must not crash the draft row.
    expect(countHolds(null)).toBe(0);
    expect(countHolds(undefined)).toBe(0);
  });

  it('ignores stray characters between tokens', () => {
    // Aurora frames have no separators, but be robust to anything non-token.
    expect(countHolds(' p1r2 , p3r4 ')).toBe(2);
  });

  it('does not match a placement id without a role code', () => {
    expect(countHolds('p1080')).toBe(0);
  });
});
