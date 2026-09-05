// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';
import { contrastRatio, readableTextColor, readableDarkText, readableLightText } from '../readable-text-color';

describe('readable text color helpers', () => {
  it('uses dark text on light grade colors', () => {
    expect(readableTextColor('#FFD400')).toBe(readableDarkText);
    expect(readableTextColor('#F03E3E')).toBe(readableDarkText);
  });

  it('uses light text on dark grade colors', () => {
    expect(readableTextColor('#7E1C8E')).toBe(readableLightText);
    expect(readableTextColor('#2A0054')).toBe(readableLightText);
  });

  it('chooses a color with at least AA contrast for known grade colors', () => {
    for (const gradeColor of ['#FFD400', '#F03E3E', '#E22A2A', '#7E1C8E', '#2A0054']) {
      const selectedTextColor = readableTextColor(gradeColor);
      expect(contrastRatio(gradeColor, selectedTextColor)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('selects black on white and white on black backgrounds', () => {
    expect(readableTextColor('#FFFFFF')).toBe(readableDarkText);
    expect(readableTextColor('#000000')).toBe(readableLightText);
  });

  it('computes known contrast ratio values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
  });

  it('returns null for invalid hex colors', () => {
    expect(contrastRatio('not-a-color', '#FFFFFF')).toBeNull();
    expect(readableTextColor('not-a-color')).toBe(readableLightText);
  });
});
