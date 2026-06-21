import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorGradeScale,
  generateGradeFocusPlan,
  generateLadderPlan,
  generatePyramidPlan,
  generateVolumePlan,
  generateWorkoutPlan,
  groupSlotsBySection,
} from '../index';

const GRADES: GeneratorGradeScale = Array.from({ length: 33 }, (_, i) => ({ difficulty_id: i + 1 }));

describe('generateVolumePlan', () => {
  it('emits exactly mainSetClimbs slots when no warm-up', () => {
    const slots = generateVolumePlan(
      { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', mainSetClimbs: 10, targetGrade: 15 },
      GRADES,
    );

    expect(slots).toHaveLength(10);
    expect(slots.every((slot) => slot.section === 'main')).toBe(true);
    expect(slots.every((slot) => slot.grade === 15)).toBe(true);
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('clamps mainSet grades to the available range when variability would overshoot', () => {
    const slots = generateVolumePlan(
      { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', mainSetClimbs: 50, mainSetVariability: 100, targetGrade: 15 },
      GRADES,
    );

    expect(slots).toHaveLength(50);
    for (const slot of slots) {
      expect(slot.grade).toBeGreaterThanOrEqual(GRADES[0].difficulty_id);
      expect(slot.grade).toBeLessThanOrEqual(GRADES[GRADES.length - 1].difficulty_id);
    }
  });

  it('adds standard warm-up slots before the main set', () => {
    const slots = generateVolumePlan(
      { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'standard', mainSetClimbs: 5, targetGrade: 20 },
      GRADES,
    );

    const warmUpSlots = slots.filter((slot) => slot.section === 'warmUp');
    const mainSlots = slots.filter((slot) => slot.section === 'main');
    expect(warmUpSlots.length).toBeGreaterThan(0);
    expect(mainSlots).toHaveLength(5);
    // All warm-up grades are below the target
    expect(warmUpSlots.every((slot) => slot.grade < 20)).toBe(true);
  });
});

describe('generatePyramidPlan', () => {
  it('builds a symmetric pyramid with one center peak for an odd climb count', () => {
    const slots = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 7, climbsPerStep: 1, targetGrade: 20 },
      GRADES,
    );

    expect(slots.map((slot) => slot.grade)).toEqual([17, 18, 19, 20, 19, 18, 17]);
    expect(slots.map((slot) => slot.section)).toEqual([
      'increasing',
      'increasing',
      'increasing',
      'peak',
      'decreasing',
      'decreasing',
      'decreasing',
    ]);
    expect(slots.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('repeats each grade step by climbsPerStep', () => {
    const slots = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 5, climbsPerStep: 2, targetGrade: 20 },
      GRADES,
    );

    expect(slots.map((slot) => slot.grade)).toEqual([18, 18, 19, 19, 20, 20, 19, 19, 18, 18]);
    expect(slots.filter((slot) => slot.section === 'peak')).toHaveLength(2);
  });

  it('peaks at the target grade exactly once per peak slot count', () => {
    const slots = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 5, climbsPerStep: 1, targetGrade: 20 },
      GRADES,
    );

    const peakSlots = slots.filter((slot) => slot.section === 'peak');
    expect(peakSlots).toHaveLength(1);
    expect(peakSlots[0].grade).toBe(20);
  });

  it('contains both an increasing and a decreasing phase', () => {
    const slots = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 5, climbsPerStep: 1, targetGrade: 20 },
      GRADES,
    );

    expect(slots.some((slot) => slot.section === 'increasing')).toBe(true);
    expect(slots.some((slot) => slot.section === 'decreasing')).toBe(true);
  });
});

describe('generateLadderPlan', () => {
  it('only produces an increasing phase capped at the target', () => {
    const slots = generateLadderPlan(
      { ...DEFAULT_LADDER_OPTIONS, warmUp: 'none', numberOfSteps: 4, climbsPerStep: 2, targetGrade: 18 },
      GRADES,
    );

    const sections = new Set(slots.map((slot) => slot.section));
    expect(sections.has('decreasing')).toBe(false);
    expect(slots.filter((slot) => slot.section === 'peak').every((slot) => slot.grade === 18)).toBe(true);
    expect(slots).toHaveLength(4 * 2);
  });

  it('does not walk above the target when warm-up ends near the target', () => {
    const slots = generateLadderPlan(
      { ...DEFAULT_LADDER_OPTIONS, warmUp: 'standard', numberOfSteps: 5, climbsPerStep: 1, targetGrade: 22 },
      GRADES,
    );

    const mainSlots = slots.filter((slot) => slot.section !== 'warmUp');
    expect(mainSlots.map((slot) => slot.grade)).toEqual([18, 19, 20, 21, 22]);
    expect(Math.max(...mainSlots.map((slot) => slot.grade))).toBe(22);
  });
});

describe('generateGradeFocusPlan', () => {
  it('emits numberOfClimbs main slots all at target grade', () => {
    const slots = generateGradeFocusPlan(
      { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', numberOfClimbs: 7, targetGrade: 22 },
      GRADES,
    );

    expect(slots).toHaveLength(7);
    expect(slots.every((slot) => slot.section === 'main' && slot.grade === 22)).toBe(true);
  });
});

describe('generateWorkoutPlan', () => {
  it('dispatches by options.type', () => {
    const volume = generateWorkoutPlan(
      { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', mainSetClimbs: 3, targetGrade: 15 },
      GRADES,
    );
    expect(volume).toHaveLength(3);

    const focus = generateWorkoutPlan(
      { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', numberOfClimbs: 4, targetGrade: 15 },
      GRADES,
    );
    expect(focus).toHaveLength(4);
  });
});

describe('warm-up against sparse / mid-range grade pools', () => {
  // MoonBoard grades start at difficulty_id: 13 (see MOONBOARD_MIN_DIFFICULTY_ID
  // in @boardsesh/board-config). Warm-up math previously assumed dense
  // contiguous integers and would emit slots below the pool's minimum.
  const MOONBOARD_LIKE_GRADES: GeneratorGradeScale = Array.from({ length: 20 }, (_, i) => ({
    difficulty_id: 13 + i,
  }));

  it('does not emit warm-up grades below the pool minimum (MoonBoard-style range)', () => {
    const slots = generateGradeFocusPlan(
      { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'standard', numberOfClimbs: 3, targetGrade: 15 },
      MOONBOARD_LIKE_GRADES,
    );
    const minId = MOONBOARD_LIKE_GRADES[0].difficulty_id;
    for (const slot of slots) {
      expect(slot.grade).toBeGreaterThanOrEqual(minId);
    }
    // Target grade is only two steps above the floor — warm-up should clamp
    // rather than walk off the bottom of the pool.
    const warmUpSlots = slots.filter((slot) => slot.section === 'warmUp');
    expect(warmUpSlots.every((slot) => slot.grade < 15)).toBe(true);
  });

  it('returns no warm-up slots when target is at the pool minimum', () => {
    const slots = generateGradeFocusPlan(
      { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'standard', numberOfClimbs: 3, targetGrade: 13 },
      MOONBOARD_LIKE_GRADES,
    );
    const warmUpSlots = slots.filter((slot) => slot.section === 'warmUp');
    expect(warmUpSlots).toHaveLength(0);
  });

  it('handles an empty grade scale by emitting no warm-up slots', () => {
    const slots = generateGradeFocusPlan(
      { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'standard', numberOfClimbs: 0, targetGrade: 15 },
      [],
    );
    expect(slots).toEqual([]);
  });
});

describe('groupSlotsBySection', () => {
  it('collapses consecutive same-section slots into one group', () => {
    const groups = groupSlotsBySection([
      { grade: 10, section: 'warmUp', index: 0 },
      { grade: 11, section: 'warmUp', index: 1 },
      { grade: 12, section: 'main', index: 2 },
      { grade: 13, section: 'main', index: 3 },
      { grade: 14, section: 'main', index: 4 },
    ]);

    expect(groups).toEqual([
      {
        section: 'warmUp',
        slots: [
          { grade: 10, section: 'warmUp', index: 0 },
          { grade: 11, section: 'warmUp', index: 1 },
        ],
      },
      {
        section: 'main',
        slots: [
          { grade: 12, section: 'main', index: 2 },
          { grade: 13, section: 'main', index: 3 },
          { grade: 14, section: 'main', index: 4 },
        ],
      },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(groupSlotsBySection([])).toEqual([]);
  });
});
