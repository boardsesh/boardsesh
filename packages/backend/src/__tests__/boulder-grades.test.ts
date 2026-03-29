import { describe, it, expect } from 'vitest';
import { fontGradeToDifficultyId } from '../utils/boulder-grades';

describe('fontGradeToDifficultyId', () => {
  describe('standard lowercase font grades', () => {
    it('returns 16 for "6a"', () => {
      expect(fontGradeToDifficultyId('6a')).toBe(16);
    });

    it('returns 25 for "7b+"', () => {
      expect(fontGradeToDifficultyId('7b+')).toBe(25);
    });

    it('returns 33 for "8c+"', () => {
      expect(fontGradeToDifficultyId('8c+')).toBe(33);
    });

    it('returns 10 for "4a"', () => {
      expect(fontGradeToDifficultyId('4a')).toBe(10);
    });

    it('returns 12 for "4c"', () => {
      expect(fontGradeToDifficultyId('4c')).toBe(12);
    });

    it('returns 22 for "7a"', () => {
      expect(fontGradeToDifficultyId('7a')).toBe(22);
    });

    it('returns 28 for "8a"', () => {
      expect(fontGradeToDifficultyId('8a')).toBe(28);
    });
  });

  describe('uppercase font grades', () => {
    it('returns 16 for "6A"', () => {
      expect(fontGradeToDifficultyId('6A')).toBe(16);
    });

    it('returns 25 for "7B+"', () => {
      expect(fontGradeToDifficultyId('7B+')).toBe(25);
    });

    it('returns 10 for "4A"', () => {
      expect(fontGradeToDifficultyId('4A')).toBe(10);
    });

    it('returns 33 for "8C+"', () => {
      expect(fontGradeToDifficultyId('8C+')).toBe(33);
    });
  });

  describe('combined Font+V grades', () => {
    it('returns 16 for "6A/V3"', () => {
      expect(fontGradeToDifficultyId('6A/V3')).toBe(16);
    });

    it('returns 25 for "7b+/V8"', () => {
      expect(fontGradeToDifficultyId('7b+/V8')).toBe(25);
    });

    it('returns 22 for "7a/V6"', () => {
      expect(fontGradeToDifficultyId('7a/V6')).toBe(22);
    });

    it('returns 10 for "4a/V0"', () => {
      expect(fontGradeToDifficultyId('4a/V0')).toBe(10);
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(fontGradeToDifficultyId('')).toBeNull();
    });

    it('returns null for unknown grade', () => {
      expect(fontGradeToDifficultyId('9a')).toBeNull();
    });

    it('returns null for "invalid"', () => {
      expect(fontGradeToDifficultyId('invalid')).toBeNull();
    });

    it('returns null for V-grade only', () => {
      expect(fontGradeToDifficultyId('V5')).toBeNull();
    });
  });

  describe('whitespace handling', () => {
    it('trims leading and trailing whitespace for "6a"', () => {
      expect(fontGradeToDifficultyId(' 6a ')).toBe(16);
    });

    it('trims whitespace for "7b+"', () => {
      expect(fontGradeToDifficultyId('  7b+  ')).toBe(25);
    });

    it('trims whitespace for combined format " 6A/V3 "', () => {
      expect(fontGradeToDifficultyId(' 6A/V3 ')).toBe(16);
    });
  });
});
