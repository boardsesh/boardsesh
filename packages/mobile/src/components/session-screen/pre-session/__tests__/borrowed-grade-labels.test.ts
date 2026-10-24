import { describe, expect, it } from 'vitest';
import { borrowedGradeLabels } from '../borrowed-grade-labels';

// Shared (Aurora) scale ids: 10 4a/V0, 11 4b/V0, 12 4c/V0, 13 5a/V1, 14 5b/V1,
// 15 5c/V2, 16 6a/V3, 17 6a+/V3, 18 6b/V4, 19 6b+/V4, 20 6c/V5, 21 6c+/V5.
describe('borrowedGradeLabels', () => {
  it('names the two grades in the climber’s format when they read apart', () => {
    expect(borrowedGradeLabels(18, 20, 'v-grade', 'kilter')).toEqual({ grade: 'V4', plannedGrade: 'V5' });
    expect(borrowedGradeLabels(18, 20, 'font', 'kilter')).toEqual({ grade: '6B', plannedGrade: '6C' });
    expect(borrowedGradeLabels(18, 20, 'both', 'kilter')).toEqual({ grade: 'V4 / 6B', plannedGrade: 'V5 / 6C' });
  });

  // The simulator QA case: a 4b climb borrowed for a 4a slot said "V0 for V0".
  it.each([
    { borrowed: 11, planned: 10, grade: 'V0 / 4B', plannedGrade: 'V0 / 4A' },
    { borrowed: 12, planned: 11, grade: 'V0 / 4C', plannedGrade: 'V0 / 4B' },
    { borrowed: 14, planned: 13, grade: 'V1 / 5B', plannedGrade: 'V1 / 5A' },
  ])(
    'adds the Font grade to both when $borrowed and $planned share a V label',
    ({ borrowed, planned, grade, plannedGrade }) => {
      expect(borrowedGradeLabels(borrowed, planned, 'v-grade', 'kilter')).toEqual({ grade, plannedGrade });
    },
  );

  it.each([
    { borrowed: 16, planned: 17, grade: 'V3', plannedGrade: 'V3+' },
    { borrowed: 19, planned: 18, grade: 'V4+', plannedGrade: 'V4' },
    { borrowed: 21, planned: 20, grade: 'V5+', plannedGrade: 'V5' },
  ])(
    'keeps the V format when the "+" already tells $borrowed from $planned',
    ({ borrowed, planned, grade, plannedGrade }) => {
      expect(borrowedGradeLabels(borrowed, planned, 'v-grade', 'kilter')).toEqual({ grade, plannedGrade });
    },
  );

  it('reads the board’s own V conversion', () => {
    // MoonBoard's 6A is V2, the same V label as 5c; on Kilter 6a is V3.
    expect(borrowedGradeLabels(15, 16, 'v-grade', 'moonboard')).toEqual({
      grade: 'V2 / 5C',
      plannedGrade: 'V2 / 6A',
    });
    expect(borrowedGradeLabels(15, 16, 'v-grade', 'kilter')).toEqual({ grade: 'V2', plannedGrade: 'V3' });
  });

  it('is null when either grade is missing or off the board scale', () => {
    expect(borrowedGradeLabels(null, 20, 'v-grade', 'kilter')).toBeNull();
    expect(borrowedGradeLabels(18, null, 'v-grade', 'kilter')).toBeNull();
    expect(borrowedGradeLabels(99, 20, 'v-grade', 'kilter')).toBeNull();
    expect(borrowedGradeLabels(18, 99, 'font', 'kilter')).toBeNull();
  });

  it('is null when the two grades are the same grade, so the row draws no empty caption', () => {
    expect(borrowedGradeLabels(18, 18, 'v-grade', 'kilter')).toBeNull();
    expect(borrowedGradeLabels(18, 18, 'font', 'kilter')).toBeNull();
  });
});
