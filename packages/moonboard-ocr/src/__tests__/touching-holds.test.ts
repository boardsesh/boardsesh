import { describe, expect, it } from 'vite-plus/test';
import { detectHoldsFromPixelData, findCircleCenters } from '../core/holds';
import type { RawPixelData } from '../image-processor/types';

function outlinedCircles(centers: [number, number][], color: [number, number, number]): RawPixelData {
  const width = 660;
  const height = 1080;
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [centerX, centerY] of centers) {
    for (let y = centerY - 34; y <= centerY + 34; y++) {
      for (let x = centerX - 34; x <= centerX + 34; x++) {
        const radius = Math.hypot(x - centerX, y - centerY);
        if (radius < 28 || radius > 34) continue;
        data.set(color, (y * width + x) * 4);
      }
    }
  }
  return { data, width, height, channels: 4 };
}

describe('touching MoonBoard hold outlines', () => {
  it.each([
    {
      centers: [
        [330, 870],
        [390, 870],
      ],
      expected: ['F4', 'G4'],
      color: [0, 255, 0],
      role: 'start',
    },
    {
      centers: [
        [330, 870],
        [390, 870],
      ],
      expected: ['F4', 'G4'],
      color: [0, 102, 255],
      role: 'hand',
    },
    {
      centers: [
        [330, 870],
        [330, 810],
      ],
      expected: ['F4', 'F5'],
      color: [255, 0, 0],
      role: 'finish',
    },
    {
      centers: [
        [270, 870],
        [330, 870],
        [390, 870],
      ],
      expected: ['E4', 'F4', 'G4'],
      color: [0, 255, 0],
      role: 'start',
    },
    { centers: [[330, 870]], expected: ['F4'], color: [76, 175, 80], role: 'start' },
    {
      centers: [
        [330, 870],
        [390, 870],
        [330, 810],
        [390, 810],
      ],
      expected: ['F4', 'F5', 'G4', 'G5'],
      color: [0, 102, 255],
      role: 'hand',
    },
  ])('keeps each $role hold at $expected', ({ centers, expected, color, role }) => {
    const pixels = outlinedCircles(centers as [number, number][], color as [number, number, number]);
    const holds = detectHoldsFromPixelData(pixels, { x: 0, y: 0, width: pixels.width, height: pixels.height });
    expect(holds.map((hold) => hold.coordinate).sort()).toEqual(expected);
    expect(holds).toHaveLength(expected.length);
    expect(holds.every((hold) => hold.type === role)).toBe(true);
  });

  it('keeps independent components separate when rings do not touch', () => {
    const pixels = outlinedCircles(
      [
        [330, 870],
        [414, 870],
      ],
      [0, 255, 0],
    );
    const centers = findCircleCenters(pixels);
    expect(centers.map(({ x, y }) => [x, y])).toEqual([
      [330, 870],
      [414, 870],
    ]);
    expect(centers).toHaveLength(2);
    expect(centers.every((center) => center.type === 'start')).toBe(true);
  });

  it('separates one connected component when the two ring outlines barely touch', () => {
    // Radius 34, centers 68 pixels apart: the outlines share one pixel.
    // A merged centroid would be x=364; the interior scan must recover both.
    const pixels = outlinedCircles(
      [
        [330, 870],
        [398, 870],
      ],
      [0, 255, 0],
    );
    const centers = findCircleCenters(pixels);
    expect(centers.map(({ x, y }) => [x, y])).toEqual([
      [330, 870],
      [398, 870],
    ]);
    expect(centers).toHaveLength(2);
    expect(centers.every((center) => center.type === 'start')).toBe(true);
  });

  it('documents the single-centroid fallback when a damaged pair has only one closed interior', () => {
    const pixels = outlinedCircles(
      [
        [330, 870],
        [398, 870],
      ],
      [0, 255, 0],
    );
    // Open the second ring with a gap wider than the one-pixel seam repair.
    // The outlines still touch, but only the first interior is enclosed.
    for (let y = 833; y <= 846; y++) {
      for (let x = 392; x <= 404; x++) pixels.data.set([255, 255, 255], (y * pixels.width + x) * 4);
    }
    let count = 0,
      sumX = 0,
      sumY = 0;
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        if (pixels.data[(y * pixels.width + x) * 4] !== 0) continue;
        count++;
        sumX += x;
        sumY += y;
      }
    }
    expect(count).toBeGreaterThan(0);
    const centers = findCircleCenters(pixels);
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ x: Math.round(sumX / count), y: Math.round(sumY / count), type: 'start' });
    // This documents the limitation, not a claim of two-hold recovery.
    // The reference validator must reject its incomplete coordinate/role set.
  });
});
