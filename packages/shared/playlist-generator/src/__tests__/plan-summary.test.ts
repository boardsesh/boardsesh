import { describe, expect, it } from 'vitest';
import { DEFAULT_PYRAMID_OPTIONS, type GeneratorGradeScale, generatePyramidPlan, summarizePlanFill } from '../index';

// MoonBoard-shaped table: difficulty ids start at 13, not 1.
const MOONBOARD_GRADES: GeneratorGradeScale = Array.from({ length: 16 }, (_, i) => ({ difficulty_id: i + 13 }));

describe('summarizePlanFill', () => {
  it('describes a fully filled pyramid with its warm-up', () => {
    const plan = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'standard', numberOfSteps: 5, climbsPerStep: 1, targetGrade: 20 },
      MOONBOARD_GRADES,
    );

    expect(summarizePlanFill(plan, plan)).toEqual({
      planned: 9,
      filled: 9,
      missing: 0,
      lowestGrade: 16,
      highestGrade: 20,
      sections: [
        { section: 'warmUp', count: 4 },
        { section: 'increasing', count: 2 },
        { section: 'peak', count: 1 },
        { section: 'decreasing', count: 2 },
      ],
    });
  });

  it('counts only the slots that found a climb', () => {
    const plan = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 5, climbsPerStep: 2, targetGrade: 20 },
      MOONBOARD_GRADES,
    );
    // The peak grade's pool was empty, so both peak slots dropped out.
    const filled = plan.filter((slot) => slot.section !== 'peak');

    const summary = summarizePlanFill(plan, filled);

    expect(summary).toMatchObject({ planned: 10, filled: 8, missing: 2, lowestGrade: 18, highestGrade: 19 });
    expect(summary.sections).toEqual([
      { section: 'increasing', count: 4 },
      { section: 'decreasing', count: 4 },
    ]);
  });

  it('reports an empty fill without a grade span', () => {
    const plan = generatePyramidPlan({ ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 20 }, MOONBOARD_GRADES);

    expect(summarizePlanFill(plan, [])).toEqual({
      planned: plan.length,
      filled: 0,
      missing: plan.length,
      lowestGrade: null,
      highestGrade: null,
      sections: [],
    });
  });

  it('never reports a negative shortfall', () => {
    const plan = generatePyramidPlan({ ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 20 }, MOONBOARD_GRADES);

    expect(summarizePlanFill([], plan).missing).toBe(0);
  });
});
