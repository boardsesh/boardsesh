import { describe, expect, it, vi } from 'vitest';
// GradeChip pulls in react-native; only its height constant matters here.
vi.mock('../../grade/GradeChip', () => ({ GRADE_CHIP_HEIGHT: 44 }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4 } }));

import { gradeRailRowHeight } from '../grade-rail-row-height';

describe('gradeRailRowHeight', () => {
  it('is 52 at the default font scale', () => {
    expect(gradeRailRowHeight(1, 'ios')).toBe(52);
    expect(gradeRailRowHeight(1, 'android')).toBe(52);
  });

  it('grows with the footnote chip labels on their iOS ramp', () => {
    // xxxLarge (fontScale 1.353 on iOS): footnote is 19pt, 19/13 = 1.46x.
    expect(gradeRailRowHeight(1.353, 'ios')).toBe(Math.ceil(52 + (19 / 13 - 1) * 22));
    // AX3 (2.643): footnote is 33pt.
    expect(gradeRailRowHeight(2.643, 'ios')).toBe(Math.ceil(52 + (33 / 13 - 1) * 22));
  });

  it('grows by fontScale itself on Android', () => {
    expect(gradeRailRowHeight(1.5, 'android')).toBe(Math.ceil(52 + 0.5 * 22));
    expect(gradeRailRowHeight(2, 'android')).toBeGreaterThan(gradeRailRowHeight(1.5, 'android'));
  });

  it('never goes below 52 for a font scale under 1', () => {
    expect(gradeRailRowHeight(0.8, 'android')).toBe(52);
    expect(gradeRailRowHeight(0.823, 'ios')).toBe(52);
    expect(gradeRailRowHeight(0, 'android')).toBe(52);
  });
});
