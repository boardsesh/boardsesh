import { describe, it, expect } from 'vitest';
import { gradeAxisFloorSteps, vGradeNumber } from '../boulder-grade-mapping';

describe('vGradeNumber', () => {
  it('parses the plain V token', () => {
    expect(vGradeNumber('V0')).toBe(0);
    expect(vGradeNumber('V11')).toBe(11);
  });

  it('parses the combined font/V strings the backend emits', () => {
    expect(vGradeNumber('6b+/V4')).toBe(4);
    expect(vGradeNumber('V12 / 7A')).toBe(12);
  });

  it('is case-insensitive', () => {
    expect(vGradeNumber('v3')).toBe(3);
  });

  it('returns null when there is no V token', () => {
    expect(vGradeNumber('8a')).toBeNull();
    expect(vGradeNumber('')).toBeNull();
  });
});

describe('gradeAxisFloorSteps', () => {
  it('returns one representative grade per V-step below the floor, easy→hard', () => {
    const steps = gradeAxisFloorSteps(11);
    expect(steps.map((grade) => grade.v_grade)).toEqual([
      'V0',
      'V1',
      'V2',
      'V3',
      'V4',
      'V5',
      'V6',
      'V7',
      'V8',
      'V9',
      'V10',
    ]);
    // The representative is the lowest font grade for each V (e.g. 4a for V0).
    expect(steps[0].font_grade).toBe('4a');
    expect(steps[3].font_grade).toBe('6a');
  });

  it('returns a single V0 step for a V1 floor', () => {
    expect(gradeAxisFloorSteps(1).map((grade) => grade.v_grade)).toEqual(['V0']);
  });

  it('is empty when the sends already reach the floor or below', () => {
    expect(gradeAxisFloorSteps(0)).toEqual([]);
    expect(gradeAxisFloorSteps(-3)).toEqual([]);
    expect(gradeAxisFloorSteps(Number.NaN)).toEqual([]);
  });
});
