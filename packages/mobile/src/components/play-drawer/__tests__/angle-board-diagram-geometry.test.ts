import { describe, expect, it } from 'vitest';
import { angleGlyphTip, getAngleArcSweepFlag } from '../angle-board-diagram-geometry';

describe('getAngleArcSweepFlag', () => {
  it('draws slab angles counter-clockwise from vertical', () => {
    expect(getAngleArcSweepFlag(-5)).toBe(0);
  });

  it('draws flat and overhanging angles clockwise', () => {
    expect(getAngleArcSweepFlag(0)).toBe(1);
    expect(getAngleArcSweepFlag(70)).toBe(1);
  });
});

describe('angleGlyphTip', () => {
  // The 24pt tick-row glyph: pivot (7, 21), arm 16, in viewBox units.
  const PIVOT = { x: 7, y: 21 };
  const ARM = 16;
  // Half the 2.5 board-edge stroke: a round cap reaches this far past the tip.
  const CAP_RADIUS = 1.25;
  const GLYPH_BOX = 24;

  it.each([
    [-5, 5.61, 5.06],
    [0, 7, 5],
    [40, 17.28, 8.74],
    [70, 22.03, 15.53],
  ])('puts the %s° tip at (%s, %s)', (angle, x, y) => {
    const tip = angleGlyphTip(angle, PIVOT, ARM);
    // ±0.01: the expected values are rounded to two places.
    expect(Math.abs(tip.x - x)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(tip.y - y)).toBeLessThanOrEqual(0.01);
  });

  it('keeps every board angle and its round cap inside the 24pt box', () => {
    for (let angle = -5; angle <= 70; angle += 5) {
      const tip = angleGlyphTip(angle, PIVOT, ARM);
      expect(tip.x - CAP_RADIUS).toBeGreaterThanOrEqual(0);
      expect(tip.x + CAP_RADIUS).toBeLessThanOrEqual(GLYPH_BOX);
      expect(tip.y - CAP_RADIUS).toBeGreaterThanOrEqual(0);
      expect(tip.y + CAP_RADIUS).toBeLessThanOrEqual(GLYPH_BOX);
    }
  });
});
