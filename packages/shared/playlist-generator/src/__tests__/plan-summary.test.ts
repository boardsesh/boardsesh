import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  type GeneratorGradeScale,
  type WorkoutRunStage,
  type WorkoutStagePacing,
  buildWorkoutRun,
  estimateWorkoutMinutes,
  expandRounds,
  generatePyramidPlan,
  planFromBlocks,
  summarizePlanFill,
} from '../index';

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
      substituted: 0,
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
      substituted: 0,
      lowestGrade: null,
      highestGrade: null,
      sections: [],
    });
  });

  it('counts the filled slots whose climb came from a nearby grade', () => {
    const plan = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 5, climbsPerStep: 1, targetGrade: 20 },
      MOONBOARD_GRADES,
    );
    // The peak grade ran short: its slot took a climb one grade down.
    const filled = plan.map((slot) => (slot.section === 'peak' ? { ...slot, grade: slot.grade - 1 } : slot));

    const summary = summarizePlanFill(plan, filled);

    expect(summary).toMatchObject({ planned: 5, filled: 5, missing: 0, substituted: 1, highestGrade: 19 });
    // The borrowed climb keeps its slot's section.
    expect(summary.sections.map((section) => section.section)).toEqual(['increasing', 'peak', 'decreasing']);
  });

  it('counts a substitution and a shortfall apart', () => {
    const plan = generatePyramidPlan(
      { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', numberOfSteps: 5, climbsPerStep: 2, targetGrade: 20 },
      MOONBOARD_GRADES,
    );
    const peaks = plan.filter((slot) => slot.section === 'peak');
    // One peak slot borrowed a grade up, the other found nothing at all.
    const filled = plan.flatMap((slot) => {
      if (slot === peaks[0]) return [{ ...slot, grade: slot.grade + 1 }];
      return slot === peaks[1] ? [] : [slot];
    });

    expect(summarizePlanFill(plan, filled)).toMatchObject({ planned: 10, filled: 9, missing: 1, substituted: 1 });
  });

  it('never reports a negative shortfall', () => {
    const plan = generatePyramidPlan({ ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 20 }, MOONBOARD_GRADES);

    expect(summarizePlanFill([], plan).missing).toBe(0);
  });
});

describe('estimateWorkoutMinutes', () => {
  const FOUR_BY_FOUR_PACING: WorkoutStagePacing = {
    mode: 'afterTick',
    restSeconds: 0,
    restBetweenRoundsSeconds: 180,
    advanceOn: 'tick',
  };

  /** A stage of `rounds` rounds of `climbsPerRound` climbs, queued round-major like Start queues a 4x4. */
  function roundsStage(climbsPerRound: number, rounds: number, pacing: WorkoutStagePacing): WorkoutRunStage {
    const itemUuids: string[] = [];
    const roundByUuid: Record<string, number> = {};
    for (let round = 1; round <= rounds; round++) {
      for (let climb = 0; climb < climbsPerRound; climb++) {
        const uuid = `r${round}-c${climb}`;
        itemUuids.push(uuid);
        roundByUuid[uuid] = round;
      }
    }
    return { id: 'four', kind: 'fourByFour', itemUuids, pacing, rounds, roundByUuid };
  }

  const flatStage = (id: string, kind: WorkoutRunStage['kind'], count: number, pacing?: WorkoutStagePacing) => ({
    id,
    kind,
    itemUuids: Array.from({ length: count }, (_, index) => `${id}-${index}`),
    ...(pacing ? { pacing } : {}),
  });

  it('counts a 4x4 as 16 tries with the changeover between climbs and the long rest between rounds', () => {
    // Per round: three climbs of 45 s + the 10 s changeover, one of 45 s + 180 s.
    // Four rounds is 1560 s, less the last round's rest: 1380 s, 23 min.
    expect(estimateWorkoutMinutes({ stages: [roundsStage(4, 4, FOUR_BY_FOUR_PACING)] })).toBe(25);
  });

  it('counts one interval per climb on the minute', () => {
    expect(
      estimateWorkoutMinutes({
        stages: [flatStage('otm', 'onTheMinute', 10, { mode: 'onTheMinute', restSeconds: 60 })],
      }),
    ).toBe(10);
    expect(
      estimateWorkoutMinutes({
        stages: [flatStage('otm', 'onTheMinute', 3, { mode: 'onTheMinute', restSeconds: 60 })],
      }),
    ).toBe(3);
  });

  it('counts a rest after every try when the stage moves on only after a send', () => {
    // The rest timer starts after every logged try, falls included. Three climbs of
    // three tries of 45 s + 180 s, less the last rest: 1845 s, 30.75 min.
    const limit = flatStage('limit', 'limitBouldering', 3, { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' });

    expect(estimateWorkoutMinutes({ stages: [limit] })).toBe(30);
  });

  it('leaves off only the rest after the last try of a limit block', () => {
    // Two climbs of three tries of 45 s + 120 s, less the last rest: 870 s, 14.5 min.
    const limit = flatStage('limit', 'limitBouldering', 2, { mode: 'afterTick', restSeconds: 120, advanceOn: 'send' });

    expect(estimateWorkoutMinutes({ stages: [limit] })).toBe(15);
  });

  it('counts a stage with no pacing of its own at a two-minute rest per climb', () => {
    const warmUp = flatStage('warm', 'warmUp', 4);
    const limit = flatStage('limit', 'limitBouldering', 3, { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' });

    // 4 × 165 s of warm-up, then the 2025 s limit block, less its last rest: 2505 s, 41.75 min.
    expect(estimateWorkoutMinutes({ stages: [warmUp, limit] })).toBe(40);
  });

  it('leaves an untimed workout without a figure', () => {
    expect(estimateWorkoutMinutes({ stages: [flatStage('warm', 'warmUp', 4), flatStage('vol', 'volume', 20)] })).toBe(
      null,
    );
    expect(estimateWorkoutMinutes({ stages: [] })).toBe(null);
  });

  it('reads the rounds from the run, so a run built at Start gets the same figure', () => {
    const plan = planFromBlocks(
      [{ kind: 'workout', options: { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 20 } }],
      () => 'four',
    );
    const entries = expandRounds(
      ['a', 'b', 'c', 'd'].map((uuid) => ({ uuid })),
      4,
      (item, round) => ({ uuid: `${item.uuid}${round}` }),
    ).map(({ item, round }) => ({ uuid: item.uuid, stageId: 'four', round }));

    expect(estimateWorkoutMinutes(buildWorkoutRun(entries, plan))).toBe(25);
  });
});
