import { describe, expect, it } from 'vitest';
import { plainRingPath, spikyRingPath, wavyRingPath } from '../spike-shapes';

/** Every coordinate pair in an SVG path built by these generators. */
function points(path: string): Array<[number, number]> {
  return [...path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
}

const radiusOf = (path: string, cx: number, cy: number): number[] =>
  points(path).map(([x, y]) => Math.hypot(x - cx, y - cy));

describe('spike-shapes', () => {
  it('closes every path so the outline has no seam', () => {
    for (const path of [plainRingPath(0, 0, 10), wavyRingPath(0, 0, 10), spikyRingPath(0, 0, 10)]) {
      expect(path.trimEnd().endsWith('Z')).toBe(true);
    }
  });

  it('keeps the wavy ring within its amplitude band', () => {
    const radii = radiusOf(wavyRingPath(100, 200, 50, 12, 0.1), 100, 200);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(50 * 0.9 - 0.01);
    expect(Math.max(...radii)).toBeLessThanOrEqual(50 * 1.1 + 0.01);
    // A ring that never reaches its extremes would look like a plain circle.
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(50 * 0.19);
  });

  it('alternates the spiky ring between its outer and inner radius', () => {
    const radii = radiusOf(spikyRingPath(0, 0, 100, 10, 0.22), 0, 0);
    expect(radii).toHaveLength(20);
    for (const [index, radius] of radii.entries()) {
      expect(radius).toBeCloseTo(index % 2 === 0 ? 122 : 78, 1);
    }
  });

  it('draws the plain ring at exactly the requested radius', () => {
    expect(plainRingPath(30, 40, 12)).toBe('M 18 40 a 12 12 0 1 0 24 0 a 12 12 0 1 0 -24 0 Z');
  });
});
