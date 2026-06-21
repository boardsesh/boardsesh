import { describe, expect, it } from 'vitest';
import { contrastRatio, readableTextColor, readableDarkText, readableLightText } from '../grade-chip-colors';

describe('grade chip color helpers', () => {
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
});
