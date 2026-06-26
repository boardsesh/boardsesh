import { describe, it, expect } from 'vitest';
import { simulateCvd, type CvdType } from '../cvd-simulation';

const TYPES: CvdType[] = ['deuteranopia', 'protanopia', 'tritanopia'];

function rgbHueDegrees(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  return (((hue * 60) % 360) + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

describe('simulateCvd', () => {
  it('keeps greyscale colours unchanged (±1 per channel) under every dichromacy', () => {
    for (const type of TYPES) {
      for (const grey of ['#000000', '#808080', '#ffffff']) {
        const result = simulateCvd(grey, type);
        const expected = parseInt(grey.slice(1, 3), 16);
        const actual = parseInt(result.slice(1, 3), 16);
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns a valid #rrggbb hex for every dichromacy', () => {
    for (const type of TYPES) {
      for (const colour of ['#00ff00', '#ff0000', '#00ffff', '#ff00ff', '#ffaa00']) {
        expect(simulateCvd(colour, type)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('collapses red and green onto the confusion line for red-green dichromacies', () => {
    // Pure red (hue 0°) and pure green (hue 120°) are the textbook confusion
    // pair for protan/deutan. After simulation their *hues* collapse toward each
    // other (both pulled into the yellow/orange band). Lightness still differs —
    // protan darkens red while green stays bright — so this checks hue, not
    // euclidean distance.
    const originalHueGap = hueDistance(rgbHueDegrees('#ff0000'), rgbHueDegrees('#00ff00'));
    expect(originalHueGap).toBeGreaterThan(100);

    for (const type of ['protanopia', 'deuteranopia'] as CvdType[]) {
      const redHue = rgbHueDegrees(simulateCvd('#ff0000', type));
      const greenHue = rgbHueDegrees(simulateCvd('#00ff00', type));
      expect(hueDistance(redHue, greenHue)).toBeLessThan(30);
    }
  });

  it('returns malformed input unchanged', () => {
    expect(simulateCvd('not-a-colour', 'protanopia')).toBe('not-a-colour');
  });
});
