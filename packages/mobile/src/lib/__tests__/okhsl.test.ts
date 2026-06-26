import { describe, it, expect } from 'vitest';
import { hexToOkhsl, okhslToHex, okhslToRgb, rgbToOkhsl } from '../okhsl';

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');
  return {
    red: parseInt(value.slice(0, 2), 16),
    green: parseInt(value.slice(2, 4), 16),
    blue: parseInt(value.slice(4, 6), 16),
  };
}

describe('okhsl round-trip', () => {
  // A spread of colours including the four default Kilter LED roles.
  const colours = [
    '#00ff00', // start (green)
    '#00ffff', // hand (cyan)
    '#ff00ff', // finish (magenta)
    '#ffaa00', // foot (orange)
    '#ff0000',
    '#0000ff',
    '#123456',
    '#abcdef',
    '#808080',
    '#1a1a1a',
    '#f4c2c2',
  ];

  it('hex → okhsl → hex returns the original colour (±1 per channel)', () => {
    for (const hex of colours) {
      const okhsl = hexToOkhsl(hex);
      expect(okhsl).not.toBeNull();
      const roundTripped = okhslToHex(okhsl!);
      const original = hexToRgb(hex);
      const result = hexToRgb(roundTripped);
      expect(Math.abs(result.red - original.red)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.green - original.green)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.blue - original.blue)).toBeLessThanOrEqual(1);
    }
  });
});

describe('okhsl extremes', () => {
  it('maps lightness 1 to white and 0 to black for any hue/saturation', () => {
    expect(okhslToRgb({ h: 120, s: 0.5, l: 1 })).toEqual({ red: 255, green: 255, blue: 255 });
    expect(okhslToRgb({ h: 300, s: 1, l: 0 })).toEqual({ red: 0, green: 0, blue: 0 });
  });

  it('reports achromatic colours with zero saturation', () => {
    const grey = rgbToOkhsl({ red: 128, green: 128, blue: 128 });
    expect(grey.s).toBeLessThan(1e-3);
  });

  it('always returns in-gamut sRGB for the full s/l unit square', () => {
    for (let h = 0; h < 360; h += 30) {
      for (let s = 0; s <= 1; s += 0.25) {
        for (let l = 0.05; l < 1; l += 0.15) {
          const { red, green, blue } = okhslToRgb({ h, s, l });
          for (const channel of [red, green, blue]) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(255);
            expect(Number.isFinite(channel)).toBe(true);
          }
        }
      }
    }
  });
});

describe('okhsl perceptual lightness independence', () => {
  it('keeps Oklab lightness (toe of l) stable as hue changes at fixed l', () => {
    // The whole point for CVD: l is independent of hue. Verify the produced
    // colours share the same Oklab L (via the inverse mapping's l) across hues.
    const targetL = 0.6;
    const recoveredLs = [0, 60, 120, 180, 240, 300].map((h) => rgbToOkhsl(okhslToRgb({ h, s: 0.7, l: targetL })).l);
    for (const l of recoveredLs) {
      expect(Math.abs(l - targetL)).toBeLessThan(0.02);
    }
  });
});
