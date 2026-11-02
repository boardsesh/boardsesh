import { describe, expect, it, vi } from 'vitest';
// GradeChip pulls in react-native; only its height constant matters here.
vi.mock('../../grade/GradeChip', () => ({ GRADE_CHIP_HEIGHT: 44 }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4 } }));

import { gradeRailRowHeight } from '../grade-rail-row-height';

describe('gradeRailRowHeight', () => {
  it('is 52 at the default font scale', () => {
    expect(gradeRailRowHeight(1)).toBe(52);
  });

  it('grows with the font scale', () => {
    expect(gradeRailRowHeight(1.5)).toBeGreaterThan(gradeRailRowHeight(1));
    expect(gradeRailRowHeight(2)).toBeGreaterThan(gradeRailRowHeight(1.5));
  });

  it('never goes below 52 for a font scale under 1', () => {
    expect(gradeRailRowHeight(0.8)).toBe(52);
    expect(gradeRailRowHeight(0)).toBe(52);
  });
});
