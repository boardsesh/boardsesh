import { describe, it, expect } from 'vite-plus/test';
import {
  getVGradeColor,
  getFontGradeColor,
  getGradeColor,
  getGradeColorWithOpacity,
  isLightColor,
  getGradeTextColor,
  getGradeTintColor,
  formatVGrade,
  V_GRADE_COLORS,
  FONT_GRADE_COLORS,
} from '../grade-colors';

describe('Grade Colors', () => {
  describe('getVGradeColor', () => {
    it('returns correct color for known V-grades', () => {
      expect(getVGradeColor('V0')).toBe('#FFD400');
      expect(getVGradeColor('V5')).toBe('#F03E3E');
      expect(getVGradeColor('V10')).toBe('#7E1C8E');
      expect(getVGradeColor('V17')).toBe('#2A0054');
    });

    it('is case-insensitive', () => {
      expect(getVGradeColor('v3')).toBe(getVGradeColor('V3'));
      expect(getVGradeColor('v10')).toBe(getVGradeColor('V10'));
    });

    it('returns undefined for null', () => {
      expect(getVGradeColor(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(getVGradeColor(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(getVGradeColor('')).toBeUndefined();
    });

    it('returns undefined for unknown grades', () => {
      expect(getVGradeColor('V99')).toBeUndefined();
      expect(getVGradeColor('V18')).toBeUndefined();
    });
  });

  describe('getFontGradeColor', () => {
    it('returns correct color for known Font grades', () => {
      expect(getFontGradeColor('6a')).toBe('#FF6D2E');
      expect(getFontGradeColor('7b+')).toBe('#B81A5A');
    });

    it('is case-insensitive', () => {
      expect(getFontGradeColor('6A')).toBe(getFontGradeColor('6a'));
      expect(getFontGradeColor('7B+')).toBe(getFontGradeColor('7b+'));
    });

    it('returns undefined for null', () => {
      expect(getFontGradeColor(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(getFontGradeColor(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(getFontGradeColor('')).toBeUndefined();
    });
  });

  describe('getGradeColor', () => {
    it('extracts V-grade from combined strings like "6a/V3"', () => {
      expect(getGradeColor('6a/V3')).toBe(V_GRADE_COLORS['V3']);
    });

    it('returns V-grade color for plain V-grade strings', () => {
      expect(getGradeColor('V5')).toBe(V_GRADE_COLORS['V5']);
    });

    it('falls back to Font grade color when no V-grade present', () => {
      expect(getGradeColor('6a')).toBe(FONT_GRADE_COLORS['6a']);
    });

    it('returns undefined for null', () => {
      expect(getGradeColor(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(getGradeColor(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(getGradeColor('')).toBeUndefined();
    });

    it('returns undefined for unrecognized difficulty strings', () => {
      expect(getGradeColor('hard')).toBeUndefined();
      expect(getGradeColor('unknown')).toBeUndefined();
    });
  });

  describe('getGradeColorWithOpacity', () => {
    it('converts hex color to rgba with given opacity', () => {
      // #FF0000 -> rgb(255, 0, 0)
      expect(getGradeColorWithOpacity('#FF0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    });

    it('uses default opacity of 0.7 when not specified', () => {
      expect(getGradeColorWithOpacity('#FF0000')).toBe('rgba(255, 0, 0, 0.7)');
    });

    it('returns default gray rgba when color is undefined', () => {
      expect(getGradeColorWithOpacity(undefined)).toBe('rgba(200, 200, 200, 0.7)');
    });

    it('works with custom opacity values', () => {
      expect(getGradeColorWithOpacity('#00FF00', 0.3)).toBe('rgba(0, 255, 0, 0.3)');
    });

    it('correctly parses a real grade color', () => {
      // V0 = #FFD400 -> rgb(255, 212, 0)
      expect(getGradeColorWithOpacity('#FFD400', 0.8)).toBe('rgba(255, 212, 0, 0.8)');
    });
  });

  describe('isLightColor', () => {
    it('returns true for light colors (yellow)', () => {
      expect(isLightColor('#FFD400')).toBe(true); // V0 golden yellow
    });

    it('returns true for white', () => {
      expect(isLightColor('#FFFFFF')).toBe(true);
    });

    it('returns false for dark colors (dark purple)', () => {
      expect(isLightColor('#2A0054')).toBe(false); // V17 dark purple
    });

    it('returns false for black', () => {
      expect(isLightColor('#000000')).toBe(false);
    });

    it('returns false for dark red', () => {
      expect(isLightColor('#9E1A78')).toBe(false); // V9 magenta-purple
    });
  });

  describe('getGradeTextColor', () => {
    it('returns black (#000000) for light backgrounds', () => {
      expect(getGradeTextColor('#FFD400')).toBe('#000000'); // V0 golden yellow
      expect(getGradeTextColor('#FFB300')).toBe('#000000'); // V1 amber
    });

    it('returns white (#FFFFFF) for dark backgrounds', () => {
      expect(getGradeTextColor('#2A0054')).toBe('#FFFFFF'); // V17
      expect(getGradeTextColor('#4A148C')).toBe('#FFFFFF'); // V15
    });

    it('returns "inherit" for undefined input', () => {
      expect(getGradeTextColor(undefined)).toBe('inherit');
    });
  });

  describe('getVGradeColor with "+" suffix', () => {
    it('strips "+" and returns correct color', () => {
      expect(getVGradeColor('V5+')).toBe(V_GRADE_COLORS['V5']);
      expect(getVGradeColor('V3+')).toBe(V_GRADE_COLORS['V3']);
    });
  });

  describe('formatVGrade', () => {
    it('extracts V-grade from combined Font/V-grade strings', () => {
      expect(formatVGrade('6a/V3')).toBe('V3');
      expect(formatVGrade('6b/V4')).toBe('V4');
    });

    it('adds "+" when Font grade has "+" and V-grade has multiple Font grades', () => {
      expect(formatVGrade('6a+/V3')).toBe('V3+'); // V3 has 6a and 6a+
      expect(formatVGrade('6c+/V5')).toBe('V5+'); // V5 has 6c and 6c+
      expect(formatVGrade('6b+/V4')).toBe('V4+'); // V4 has 6b and 6b+
      expect(formatVGrade('7b+/V8')).toBe('V8+'); // V8 has 7b and 7b+
    });

    it('does not add "+" when V-grade has only one Font grade', () => {
      expect(formatVGrade('7a+/V7')).toBe('V7'); // V7 only has 7a+
      expect(formatVGrade('7c+/V10')).toBe('V10'); // V10 only has 7c+
      expect(formatVGrade('8a+/V12')).toBe('V12'); // V12 only has 8a+
      expect(formatVGrade('8b+/V14')).toBe('V14'); // V14 only has 8b+
      expect(formatVGrade('8c+/V16')).toBe('V16'); // V16 only has 8c+
    });

    it('returns plain V-grade when Font grade has no "+"', () => {
      expect(formatVGrade('6c/V5')).toBe('V5');
      expect(formatVGrade('7a/V6')).toBe('V6');
    });

    it('passes through bare V-grade strings without "+"', () => {
      expect(formatVGrade('V3')).toBe('V3');
      expect(formatVGrade('V10')).toBe('V10');
    });

    it('returns null for strings without V-grade', () => {
      expect(formatVGrade('6A')).toBeNull();
      expect(formatVGrade('0')).toBeNull();
    });

    it('returns null for null/undefined/empty', () => {
      expect(formatVGrade(null)).toBeNull();
      expect(formatVGrade(undefined)).toBeNull();
      expect(formatVGrade('')).toBeNull();
    });
  });

  describe('getGradeTintColor', () => {
    describe('session variant', () => {
      it('returns hsl with 35% saturation and 82% lightness in light mode', () => {
        const result = getGradeTintColor('6a/V3', 'session', false);
        expect(result).toBeDefined();
        // Should be hsl(hue, 35%, 82%)
        expect(result).toMatch(/^hsl\(\d+, 35%, 82%\)$/);
      });

      it('returns hsla with 40% saturation, 14% lightness, and 0.85 alpha in dark mode', () => {
        const result = getGradeTintColor('6a/V3', 'session', true);
        expect(result).toBeDefined();
        // Should be hsla(hue, 40%, 14%, 0.85)
        expect(result).toMatch(/^hsla\(\d+, 40%, 14%, 0\.85\)$/);
      });

      it('returns undefined when difficulty is null', () => {
        expect(getGradeTintColor(null, 'session')).toBeUndefined();
      });

      it('returns undefined when difficulty is undefined', () => {
        expect(getGradeTintColor(undefined, 'session')).toBeUndefined();
      });

      it('returns undefined when difficulty is empty string', () => {
        expect(getGradeTintColor('', 'session')).toBeUndefined();
      });

      it('uses same hue as other variants for the same difficulty', () => {
        const difficulty = '6c/V5';
        const sessionLight = getGradeTintColor(difficulty, 'session', false);
        const defaultLight = getGradeTintColor(difficulty, 'default', false);

        // Both should have the same hue
        const sessionHue = sessionLight?.match(/\d+/)?.[0];
        const defaultHue = defaultLight?.match(/\d+/)?.[0];
        expect(sessionHue).toBe(defaultHue);
      });

      it('produces different output in light vs dark mode', () => {
        const lightResult = getGradeTintColor('6a/V3', 'session', false);
        const darkResult = getGradeTintColor('6a/V3', 'session', true);
        expect(lightResult).not.toBe(darkResult);
      });
    });

    describe('default variant', () => {
      it('returns hsl with 30% saturation and 88% lightness in light mode', () => {
        const result = getGradeTintColor('6a/V3', 'default', false);
        expect(result).toMatch(/^hsl\(\d+, 30%, 88%\)$/);
      });

      it('returns hsla with 35% saturation, 28% lightness, and 0.6 alpha in dark mode', () => {
        const result = getGradeTintColor('6a/V3', 'default', true);
        expect(result).toMatch(/^hsla\(\d+, 35%, 28%, 0\.6\)$/);
      });
    });

    describe('light variant', () => {
      it('returns hsl with 20% saturation and 94% lightness in light mode', () => {
        const result = getGradeTintColor('6a/V3', 'light', false);
        expect(result).toMatch(/^hsl\(\d+, 20%, 94%\)$/);
      });

      it('returns hsl with 25% saturation and 22% lightness in dark mode', () => {
        const result = getGradeTintColor('6a/V3', 'light', true);
        expect(result).toMatch(/^hsl\(\d+, 25%, 22%\)$/);
      });
    });

    it('returns undefined for unrecognized difficulty strings', () => {
      expect(getGradeTintColor('hard', 'session')).toBeUndefined();
      expect(getGradeTintColor('unknown', 'default')).toBeUndefined();
    });
  });
});
