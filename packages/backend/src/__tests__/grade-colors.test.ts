import { describe, it, expect } from 'vite-plus/test';
import { getVGradeColor, getFontGradeColor, getGradeColor } from '../graphql/resolvers/controller/grade-colors';

const DEFAULT_GRADE_COLOR = '#808080';

describe('Grade Color Utilities', () => {
  describe('getVGradeColor', () => {
    it('should return correct color for V0', () => {
      expect(getVGradeColor('V0')).toBe('#FFD400');
    });

    it('should return correct color for V5', () => {
      expect(getVGradeColor('V5')).toBe('#F03E3E');
    });

    it('should return correct color for V10', () => {
      expect(getVGradeColor('V10')).toBe('#7E1C8E');
    });

    it('should return correct color for V17', () => {
      expect(getVGradeColor('V17')).toBe('#2A0054');
    });

    it('should be case insensitive', () => {
      expect(getVGradeColor('v3')).toBe('#FF6D2E');
      expect(getVGradeColor('v10')).toBe('#7E1C8E');
    });

    it('should return default color for invalid V-grade', () => {
      expect(getVGradeColor('V18')).toBe(DEFAULT_GRADE_COLOR);
      expect(getVGradeColor('V-1')).toBe(DEFAULT_GRADE_COLOR);
      expect(getVGradeColor('invalid')).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for null', () => {
      expect(getVGradeColor(null)).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for undefined', () => {
      expect(getVGradeColor(undefined)).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for empty string', () => {
      expect(getVGradeColor('')).toBe(DEFAULT_GRADE_COLOR);
    });
  });

  describe('getFontGradeColor', () => {
    it('should return correct color for 4a (V0 equivalent)', () => {
      expect(getFontGradeColor('4a')).toBe('#FFD400');
    });

    it('should return correct color for 6a', () => {
      expect(getFontGradeColor('6a')).toBe('#FF6D2E');
    });

    it('should return correct color for 6a+', () => {
      expect(getFontGradeColor('6a+')).toBe('#FF6D2E');
    });

    it('should return correct color for 7b+', () => {
      expect(getFontGradeColor('7b+')).toBe('#B81A5A');
    });

    it('should return correct color for 8c+', () => {
      expect(getFontGradeColor('8c+')).toBe('#38006B');
    });

    it('should be case insensitive', () => {
      expect(getFontGradeColor('6A')).toBe('#FF6D2E');
      expect(getFontGradeColor('7B+')).toBe('#B81A5A');
    });

    it('should return default color for invalid Font grade', () => {
      expect(getFontGradeColor('9a')).toBe(DEFAULT_GRADE_COLOR);
      expect(getFontGradeColor('invalid')).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for null', () => {
      expect(getFontGradeColor(null)).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for undefined', () => {
      expect(getFontGradeColor(undefined)).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for empty string', () => {
      expect(getFontGradeColor('')).toBe(DEFAULT_GRADE_COLOR);
    });
  });

  describe('getGradeColor', () => {
    it('should extract V-grade from mixed format "6a/V3"', () => {
      expect(getGradeColor('6a/V3')).toBe('#FF6D2E'); // V3 color
    });

    it('should extract V-grade from mixed format "7b/V8"', () => {
      expect(getGradeColor('7b/V8')).toBe('#B81A5A'); // V8 color
    });

    it('should prefer V-grade over Font grade', () => {
      // If both are present, V-grade takes precedence
      expect(getGradeColor('6a/V5')).toBe('#F03E3E'); // V5 color, not 6a color
    });

    it('should handle standalone V-grade', () => {
      expect(getGradeColor('V4')).toBe('#FF5026');
    });

    it('should fall back to Font grade when no V-grade present', () => {
      expect(getGradeColor('6a')).toBe('#FF6D2E');
      expect(getGradeColor('7a+')).toBe('#CF1F3C');
    });

    it('should be case insensitive for V-grade extraction', () => {
      expect(getGradeColor('6a/v3')).toBe('#FF6D2E');
    });

    it('should be case insensitive for Font grade extraction', () => {
      expect(getGradeColor('6A')).toBe('#FF6D2E');
    });

    it('should return default color for invalid difficulty string', () => {
      expect(getGradeColor('invalid')).toBe(DEFAULT_GRADE_COLOR);
      expect(getGradeColor('easy')).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for null', () => {
      expect(getGradeColor(null)).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for undefined', () => {
      expect(getGradeColor(undefined)).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should return default color for empty string', () => {
      expect(getGradeColor('')).toBe(DEFAULT_GRADE_COLOR);
    });

    it('should handle V-grade embedded in longer strings', () => {
      expect(getGradeColor('Grade: V7 (Hard)')).toBe('#CF1F3C');
    });

    it('should handle Font grade embedded in longer strings', () => {
      expect(getGradeColor('Grade: 7a (Hard)')).toBe('#E22A2A');
    });
  });
});
