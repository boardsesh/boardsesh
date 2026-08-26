import { describe, expect, it } from 'vitest';
import { getAngleArcSweepFlag } from '../angle-board-diagram-geometry';

describe('getAngleArcSweepFlag', () => {
  it('draws slab angles counter-clockwise from vertical', () => {
    expect(getAngleArcSweepFlag(-5)).toBe(0);
  });

  it('draws flat and overhanging angles clockwise', () => {
    expect(getAngleArcSweepFlag(0)).toBe(1);
    expect(getAngleArcSweepFlag(70)).toBe(1);
  });
});
