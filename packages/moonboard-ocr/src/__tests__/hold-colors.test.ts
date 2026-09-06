import { describe, expect, it } from 'vite-plus/test';
import { classifyPixelColor } from '../core/holds';

describe('MoonBoard hold colors across app platforms', () => {
  it.each([
    [255, 0, 0, 'finish'],
    [244, 15, 9, 'finish'],
    [0, 255, 0, 'start'],
    [13, 243, 10, 'start'],
    [0, 102, 255, 'hand'],
    [244, 67, 54, 'finish'],
    [225, 82, 64, 'finish'],
    [76, 175, 80, 'start'],
    [100, 160, 80, 'start'],
    [41, 97, 255, 'hand'],
  ] as const)('classifies RGB(%i, %i, %i) as %s', (red, green, blue, expected) => {
    expect(classifyPixelColor(red, green, blue)).toBe(expected);
  });

  it.each([
    [238, 223, 80], // Yellow board background
    [255, 255, 0],
    [255, 255, 255], // Logo
    [32, 32, 32], // Dark app UI
    [0, 0, 0],
    [0, 255, 255],
    [255, 0, 255],
    [255, 128, 0], // Orange benchmark marker
  ] as const)('ignores non-hold RGB(%i, %i, %i)', (red, green, blue) => {
    expect(classifyPixelColor(red, green, blue)).toBeNull();
  });
});
