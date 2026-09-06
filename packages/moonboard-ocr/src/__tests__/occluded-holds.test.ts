import { describe, expect, it } from 'vite-plus/test';
import { detectHoldsFromPixelData } from '../core/holds';
import type { RawPixelData } from '../image-processor/types';

function orderedRings(rings: { x: number; y: number; color: number[] }[]): RawPixelData {
  const width = 660;
  const height = 1080;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  for (const ring of rings) {
    for (let y = ring.y - 34; y <= ring.y + 34; y++) {
      for (let x = ring.x - 34; x <= ring.x + 34; x++) {
        const radius = Math.hypot(x - ring.x, y - ring.y);
        if (radius >= 28 && radius <= 34) pixels.set(ring.color, (y * width + x) * 4);
      }
    }
  }
  return { width, height, channels: 4, data: pixels };
}

describe('overlapping rings with different roles', () => {
  it('closes a narrow unclassified seam at a blended red/blue overlap', () => {
    const pixels = orderedRings([
      { x: 330, y: 510, color: [0, 102, 255] },
      { x: 330, y: 450, color: [0, 102, 255] },
      { x: 330, y: 390, color: [255, 0, 0] },
    ]);
    const seam: number[] = [];
    for (let y = 350; y < 550; y++) {
      for (let x = 290; x < 370; x++) {
        const index = y * pixels.width + x;
        if (pixels.data[index * 4] !== 0 || pixels.data[index * 4 + 2] !== 255) continue;
        const neighbors = [index - 1, index + 1, index - pixels.width, index + pixels.width];
        if (neighbors.some((neighbor) => pixels.data[neighbor * 4] === 255 && pixels.data[neighbor * 4 + 2] === 0)) {
          seam.push(index);
        }
      }
    }
    expect(seam.length).toBeGreaterThan(0);
    for (const index of seam) pixels.data.set([127, 51, 127], index * 4);
    const holds = detectHoldsFromPixelData(
      pixels,
      { x: 0, y: 0, width: pixels.width, height: pixels.height },
      18,
      'android',
    );
    expect(holds.map(({ coordinate, type }) => `${coordinate}:${type}`).sort()).toEqual([
      'F10:hand',
      'F11:hand',
      'F12:finish',
    ]);
  });

  it('retains a blue hold whose top is covered by a red finish ring', () => {
    // Reproduces the independently selected Mini 2025 failure, using synthetic
    // geometry only: two connected blue rings, then a red ring painted above.
    const pixels = orderedRings([
      { x: 330, y: 510, color: [0, 102, 255] },
      { x: 330, y: 450, color: [0, 102, 255] },
      { x: 330, y: 390, color: [255, 0, 0] },
    ]);
    const holds = detectHoldsFromPixelData(
      pixels,
      { x: 0, y: 0, width: pixels.width, height: pixels.height },
      18,
      'android',
    );
    expect(holds.map(({ coordinate, type }) => `${coordinate}:${type}`).sort()).toEqual([
      'F10:hand',
      'F11:hand',
      'F12:finish',
    ]);
  });

  it('retains the original roles for a horizontal overlap too', () => {
    const pixels = orderedRings([
      { x: 390, y: 450, color: [0, 102, 255] },
      { x: 330, y: 450, color: [0, 102, 255] },
      { x: 270, y: 450, color: [0, 255, 0] },
    ]);
    const holds = detectHoldsFromPixelData(
      pixels,
      { x: 0, y: 0, width: pixels.width, height: pixels.height },
      18,
      'android',
    );
    expect(holds.map(({ coordinate, type }) => `${coordinate}:${type}`).sort()).toEqual([
      'E11:start',
      'F11:hand',
      'G11:hand',
    ]);
  });

  it('does not assign an unrelated enclosed red ring or a large empty gap to blue', () => {
    const centers = [
      [270, 390],
      [330, 390],
      [390, 390],
      [450, 390],
      [450, 450],
      [450, 510],
      [450, 570],
      [390, 570],
      [330, 570],
      [270, 570],
      [270, 510],
      [270, 450],
    ];
    const pixels = orderedRings([
      ...centers.map(([x, y]) => ({ x, y, color: [0, 102, 255] })),
      { x: 330, y: 450, color: [255, 0, 0] },
    ]);
    const holds = detectHoldsFromPixelData(
      pixels,
      { x: 0, y: 0, width: pixels.width, height: pixels.height },
      18,
      'android',
    );
    const expected = centers.map(
      ([x, y]) => `${String.fromCharCode(65 + Math.floor(x / 60))}${18 - Math.floor(y / 60)}:hand`,
    );
    expected.push('F11:finish');
    expect(holds.map(({ coordinate, type }) => `${coordinate}:${type}`).sort()).toEqual(expected.sort());
  });
});
