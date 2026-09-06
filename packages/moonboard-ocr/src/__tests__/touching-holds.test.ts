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

  it('keeps near-miss outlines separate at 1.4 cells of center spacing', () => {
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
});
