import { describe, it, expect } from 'vitest';
import {
  getGradeColorWithOpacity,
  isLightColor,
  getGradeTextColor,
  getGradeTintColor,
  hexToHSL,
  formatGrade,
  formatGradeByDifficultyId,
  formatVGrade,
  formatFontGrade,
  softenColor,
  getSoftGradeColor,
  getSoftVGradeColor,
  getSoftFontGradeColor,
  getSoftGradeColorByFormat,
  DEFAULT_GRADE_DISPLAY_FORMAT,
} from '../grade-display';

describe('getGradeColorWithOpacity', () => {
  it('returns an rgba string for a valid hex color', () => {
    expect(getGradeColorWithOpacity('#FF5722', 0.5)).toBe('rgba(255, 87, 34, 0.5)');
  });

  it('uses default opacity of 0.7', () => {
    expect(getGradeColorWithOpacity('#FF5722')).toBe('rgba(255, 87, 34, 0.7)');
  });

  it('returns a fallback rgba for undefined color', () => {
    expect(getGradeColorWithOpacity(undefined)).toBe('rgba(200, 200, 200, 0.7)');
  });

  it('handles hex without # prefix', () => {
    expect(getGradeColorWithOpacity('FF5722', 0.5)).toBe('rgba(255, 87, 34, 0.5)');
  });
});

describe('isLightColor', () => {
  it('returns true for white', () => {
    expect(isLightColor('#FFFFFF')).toBe(true);
  });

  it('returns false for black', () => {
    expect(isLightColor('#000000')).toBe(false);
  });

  it('returns true for a light yellow', () => {
    expect(isLightColor('#FFEB3B')).toBe(true);
  });

  it('returns false for a dark red', () => {
    expect(isLightColor('#B71C1C')).toBe(false);
  });
});

describe('getGradeTextColor', () => {
  it('returns white for a dark background', () => {
    expect(getGradeTextColor('#000000')).toBe('#FFFFFF');
  });

  it('returns black for a light background', () => {
    expect(getGradeTextColor('#FFFFFF')).toBe('#000000');
  });

  it('returns inherit for undefined input', () => {
    expect(getGradeTextColor(undefined)).toBe('inherit');
  });
});

describe('getGradeTintColor', () => {
  it('returns an hsl string for a valid difficulty', () => {
    const result = getGradeTintColor('6a/V3');
    expect(result).toBeDefined();
    expect(result).toMatch(/^hsl/);
  });

  it('returns undefined for null difficulty', () => {
    expect(getGradeTintColor(null)).toBeUndefined();
  });

  it('returns undefined for undefined difficulty', () => {
    expect(getGradeTintColor(undefined)).toBeUndefined();
  });

  it('returns a light variant when requested', () => {
    const result = getGradeTintColor('6a/V3', 'light');
    expect(result).toBeDefined();
    expect(result).toMatch(/^hsl\(/);
    expect(result).toContain('94%');
  });

  it('returns a session variant when requested', () => {
    const result = getGradeTintColor('6a/V3', 'session');
    expect(result).toBeDefined();
    expect(result).toMatch(/^hsl\(/);
    expect(result).toContain('82%');
  });

  it('returns dark mode variant with lower lightness', () => {
    const defaultResult = getGradeTintColor('6a/V3', 'default', true);
    expect(defaultResult).toBeDefined();
    expect(defaultResult).toMatch(/^hsla\(/);
  });

  it('returns dark mode light variant', () => {
    const result = getGradeTintColor('6a/V3', 'light', true);
    expect(result).toBeDefined();
    expect(result).toMatch(/^hsl\(/);
    expect(result).toContain('22%');
  });
});

describe('hexToHSL', () => {
  it('converts pure red correctly', () => {
    const result = hexToHSL('#FF0000');
    expect(result.h).toBe(0);
    expect(result.s).toBeCloseTo(1, 5);
    expect(result.l).toBeCloseTo(0.5, 5);
  });

  it('converts pure green correctly', () => {
    const result = hexToHSL('#00FF00');
    expect(result.h).toBe(120);
    expect(result.s).toBeCloseTo(1, 5);
    expect(result.l).toBeCloseTo(0.5, 5);
  });

  it('converts gray correctly', () => {
    const result = hexToHSL('#808080');
    expect(result.h).toBe(0);
    expect(result.s).toBe(0);
    expect(result.l).toBeCloseTo(0.502, 2);
  });

  it('converts pure blue correctly', () => {
    const result = hexToHSL('#0000FF');
    expect(result.h).toBe(240);
    expect(result.s).toBeCloseTo(1, 5);
    expect(result.l).toBeCloseTo(0.5, 5);
  });

  it('converts white correctly', () => {
    const result = hexToHSL('#FFFFFF');
    expect(result.h).toBe(0);
    expect(result.s).toBe(0);
    expect(result.l).toBeCloseTo(1, 5);
  });
});

describe('formatVGrade', () => {
  it('extracts the V part of a combined difficulty', () => {
    expect(formatVGrade('6a/V3')).toBe('V3');
    // The Font part has no "+" so no disambiguation suffix, regardless of mapping count.
    expect(formatVGrade('7b/V8')).toBe('V8');
  });

  it('adds "+" when the Font part has "+" AND V-grade has multiple Font mappings', () => {
    // V5 maps from both "6c" and "6c+" in BOULDER_GRADES → "+" is meaningful.
    expect(formatVGrade('6c+/V5')).toBe('V5+');
  });

  it('does not add "+" when V-grade has only one Font mapping', () => {
    // V7 only comes from "7a+" → no disambiguation needed.
    expect(formatVGrade('7a+/V7')).toBe('V7');
  });

  it('accepts a bare V label', () => {
    expect(formatVGrade('V10')).toBe('V10');
  });

  it('preserves a plus suffix on a bare V label', () => {
    expect(formatVGrade('V5+')).toBe('V5+');
  });

  it('returns null for missing / unparseable input', () => {
    expect(formatVGrade(null)).toBeNull();
    expect(formatVGrade(undefined)).toBeNull();
    expect(formatVGrade('')).toBeNull();
    expect(formatVGrade('not a grade')).toBeNull();
  });
});

describe('formatFontGrade', () => {
  it('uppercases the Font part of a combined difficulty', () => {
    expect(formatFontGrade('6a/V3')).toBe('6A');
    expect(formatFontGrade('7b+/V8')).toBe('7B+');
  });

  it('falls back to a standalone Font match', () => {
    expect(formatFontGrade('6a')).toBe('6A');
    expect(formatFontGrade('7b+')).toBe('7B+');
  });

  it('returns null for missing / unparseable input', () => {
    expect(formatFontGrade(null)).toBeNull();
    expect(formatFontGrade(undefined)).toBeNull();
    expect(formatFontGrade('')).toBeNull();
    expect(formatFontGrade('Vasdf')).toBeNull();
  });
});

describe('formatGrade', () => {
  it('routes to V or Font based on format', () => {
    expect(formatGrade('6c+/V5', 'v-grade')).toBe('V5+');
    expect(formatGrade('6c+/V5', 'font')).toBe('6C+');
    expect(formatGrade('6c+/V5', 'both')).toBe('V5+ / 6C+');
  });

  it('defaults to V via DEFAULT_GRADE_DISPLAY_FORMAT export', () => {
    expect(DEFAULT_GRADE_DISPLAY_FORMAT).toBe('v-grade');
    expect(formatGrade('6a/V3', DEFAULT_GRADE_DISPLAY_FORMAT)).toBe('V3');
  });

  it('returns null gracefully', () => {
    expect(formatGrade(null, 'v-grade')).toBeNull();
    expect(formatGrade(undefined, 'font')).toBeNull();
    expect(formatGrade(null, 'both')).toBeNull();
  });

  it('falls back to whichever scale can be parsed when formatting both', () => {
    expect(formatGrade('V10', 'both')).toBe('V10');
    expect(formatGrade('7b+', 'both')).toBe('7B+');
  });
});

describe('formatGradeByDifficultyId', () => {
  it('formats known difficulty ids in every display format', () => {
    expect(formatGradeByDifficultyId(21, 'v-grade')).toBe('V5+');
    expect(formatGradeByDifficultyId(21, 'font')).toBe('6C+');
    expect(formatGradeByDifficultyId(21, 'both')).toBe('V5+ / 6C+');
  });

  it('returns null for missing or unknown ids', () => {
    expect(formatGradeByDifficultyId(null, 'both')).toBeNull();
    expect(formatGradeByDifficultyId(undefined, 'both')).toBeNull();
    expect(formatGradeByDifficultyId(999, 'both')).toBeNull();
  });
});

describe('softenColor', () => {
  it('returns a light-mode HSL with the source hue', () => {
    // #FF0000 is hue 0 (red).
    expect(softenColor('#FF0000', false)).toBe('hsl(0, 72%, 44%)');
  });

  it('returns a dark-mode HSL with higher lightness for contrast', () => {
    expect(softenColor('#FF0000', true)).toBe('hsl(0, 80%, 77%)');
  });

  it('treats the absence of darkMode as light-mode', () => {
    expect(softenColor('#FF0000')).toBe(softenColor('#FF0000', false));
  });
});

describe('getSoftGradeColor variants', () => {
  it('returns a softened color for a recognised V-grade', () => {
    const color = getSoftVGradeColor('V3');
    expect(color).toMatch(/^hsl\(\d+, 72%, 44%\)$/);
  });

  it('returns a softened color for a recognised Font grade', () => {
    const color = getSoftFontGradeColor('6a');
    expect(color).toMatch(/^hsl\(\d+, 72%, 44%\)$/);
  });

  it('returns undefined for unknown grades', () => {
    expect(getSoftVGradeColor('V99')).toBeUndefined();
    expect(getSoftFontGradeColor('9z')).toBeUndefined();
    expect(getSoftGradeColor(null)).toBeUndefined();
    expect(getSoftGradeColor(undefined)).toBeUndefined();
  });

  it('uses the V part when format is "v-grade"', () => {
    const byFormat = getSoftGradeColorByFormat('6a/V3', 'v-grade');
    const byV = getSoftVGradeColor('V3');
    expect(byFormat).toBe(byV);
  });

  it('uses the Font part when format is "font"', () => {
    const byFormat = getSoftGradeColorByFormat('6a/V3', 'font');
    const byFont = getSoftFontGradeColor('6A');
    expect(byFormat).toBe(byFont);
  });
});
