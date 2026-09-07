import { describe, expect, it } from 'vite-plus/test';
import { detectBenchmarkCircle } from '../core/holds';
import type { RawPixelData } from '../image-processor/types';

function circles(centers: number[], radius: number, color: number[]): RawPixelData {
  const width = 300;
  const height = 80;
  const pixels = new Uint8Array(width * height * 4);
  for (const centerX of centers) {
    for (let y = 40 - radius; y <= 40 + radius; y++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        if (Math.hypot(x - centerX, y - 40) <= radius) pixels.set(color, (y * width + x) * 4);
      }
    }
    // A dark glyph reduces the colored badge area, as the real B does.
    for (let y = 32; y < 48; y++) {
      for (let x = centerX - 2; x < centerX + 2; x++) pixels.set([0, 0, 0], (y * width + x) * 4);
    }
  }
  return { width, height, channels: 4, data: pixels };
}

describe('profile-specific benchmark badge colors', () => {
  it('recognizes the smaller bright-gold Android badge', () => {
    const pixels = circles([100], 19, [255, 193, 7]);
    expect(detectBenchmarkCircle(pixels, 'android')).toBe(true);
    expect(detectBenchmarkCircle(pixels)).toBe(false);
  });

  it('preserves muted-gold iOS badge detection', () => {
    expect(detectBenchmarkCircle(circles([100], 24, [211, 175, 88]))).toBe(true);
  });

  it('keeps compressed bright and muted badge pixels in one component', () => {
    const pixels = circles([100], 18, [255, 193, 7]);
    const colors = [
      [255, 183, 32],
      [232, 177, 70],
      [209, 153, 58],
      [255, 193, 7],
    ];
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        const index = (y * pixels.width + x) * 4;
        if (pixels.data[index]) pixels.data.set(colors[x % colors.length], index);
      }
    }
    expect(detectBenchmarkCircle(pixels, 'android')).toBe(true);
    expect(detectBenchmarkCircle(pixels)).toBe(false);
  });

  it('does not combine separate small gold rating glyphs into a badge', () => {
    expect(detectBenchmarkCircle(circles([50, 85, 120, 155, 190], 12, [255, 193, 7]), 'android')).toBe(false);
  });

  it('does not classify a red beta counter as a benchmark', () => {
    expect(detectBenchmarkCircle(circles([100], 24, [244, 67, 54]), 'android')).toBe(false);
  });
});
