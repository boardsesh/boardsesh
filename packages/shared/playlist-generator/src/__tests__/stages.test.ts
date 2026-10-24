import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorGradeScale,
  type GeneratorOptions,
  type StagedSlot,
  WARM_UP_OPTIONS,
  WORKOUT_STAGE_KINDS,
  type WorkoutPlan,
  type WorkoutRun,
  type WorkoutRunEntry,
  type WorkoutBlockSpec,
  type WorkoutStage,
  type WorkoutStageFilters,
  type WorkoutStagePacing,
  appendStageToRun,
  buildWorkoutRun,
  expandRounds,
  generateStagedPlan,
  generateWorkoutPlan,
  isWorkoutStageKind,
  locateInRun,
  planFromBlocks,
  pruneRun,
  workoutRunHasPacing,
} from '../index';

const DENSE_GRADES: GeneratorGradeScale = Array.from({ length: 33 }, (_, i) => ({ difficulty_id: i + 1 }));
const MOONBOARD_GRADES: GeneratorGradeScale = Array.from({ length: 16 }, (_, i) => ({ difficulty_id: i + 13 }));
const SPARSE_GRADES: GeneratorGradeScale = [13, 17, 21, 25].map((difficulty_id) => ({ difficulty_id }));

const GRADE_CASES: Array<{ name: string; grades: GeneratorGradeScale; targetGrade: number }> = [
  { name: 'dense mid-range', grades: DENSE_GRADES, targetGrade: 15 },
  { name: 'dense lowest grade', grades: DENSE_GRADES, targetGrade: 1 },
  { name: 'MoonBoard-like mid-range', grades: MOONBOARD_GRADES, targetGrade: 20 },
  { name: 'MoonBoard-like lowest grade', grades: MOONBOARD_GRADES, targetGrade: 13 },
  { name: 'sparse top grade', grades: SPARSE_GRADES, targetGrade: 25 },
  { name: 'sparse lowest grade', grades: SPARSE_GRADES, targetGrade: 13 },
  { name: 'sparse above the top grade', grades: SPARSE_GRADES, targetGrade: 26 },
  { name: 'MoonBoard-like below the lowest grade', grades: MOONBOARD_GRADES, targetGrade: 10 },
  { name: 'empty scale', grades: [], targetGrade: 5 },
];

const WORKOUT_CASES: GeneratorOptions[] = [
  { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 0, mainSetClimbs: 6, mainSetVariability: 0 },
  { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 0, mainSetClimbs: 6, mainSetVariability: 3 },
  { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 0, numberOfSteps: 5, climbsPerStep: 2 },
  { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 0, numberOfSteps: 4, climbsPerStep: 1 },
  { ...DEFAULT_LADDER_OPTIONS, targetGrade: 0, numberOfSteps: 5, climbsPerStep: 2 },
  { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 0, numberOfClimbs: 7 },
  { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 0, numberOfClimbs: 6 },
  { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 0, climbsPerRound: 4, rounds: 3 },
  { ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 0, numberOfClimbs: 3 },
];

const EQUIVALENCE_CASES = WORKOUT_CASES.flatMap((workout) =>
  WARM_UP_OPTIONS.flatMap((warmUp) =>
    GRADE_CASES.map(({ name, grades, targetGrade }) => ({
      label: `${workout.type}${workout.type === 'volume' ? ` variability ${workout.mainSetVariability}` : ''} / warm-up ${warmUp} / ${name}`,
      options: { ...workout, warmUp, targetGrade },
      grades,
    })),
  ),
);

// Volume's variability draws from Math.random; replay the same sequence for both generators.
const seedRandom = () => {
  let seed = 42;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  });
};

// A counter id factory, as the app would pass a uuid factory.
const counterIds = () => {
  let nextId = 0;
  return () => `stage-${nextId++}`;
};

const withoutStageId = (slots: StagedSlot[]) => slots.map(({ stageId: _stageId, ...slot }) => slot);

// The blocks a single-type selection with its own warm-up becomes: the warm-up
// as a block of its own, then the workout.
const blocksFor = (options: GeneratorOptions): WorkoutBlockSpec[] => [
  ...(options.warmUp === 'none' ? [] : [{ kind: 'warmUp' as const, warmUpType: options.warmUp }]),
  { kind: 'workout', options },
];
const workoutBlock = (options: GeneratorOptions): WorkoutBlockSpec => ({ kind: 'workout', options });
const STRICT_FILTERS: WorkoutStageFilters = {
  climbBias: 'any',
  minAscents: 50,
  minRating: 3,
  onlyTallClimbs: true,
  onlyWideClimbs: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateStagedPlan matches generateWorkoutPlan', () => {
  it.each(EQUIVALENCE_CASES)('$label', ({ options, grades }) => {
    seedRandom();
    const expected = generateWorkoutPlan(options, grades);
    vi.restoreAllMocks();
    seedRandom();
    const staged = generateStagedPlan(planFromBlocks(blocksFor(options), counterIds()), grades);

    expect(withoutStageId(staged)).toEqual(expected);
  });

  it('tags warm-up slots with the warm-up stage and the rest with the workout stage', () => {
    const plan = planFromBlocks(
      blocksFor({ ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'standard', targetGrade: 20 }),
      counterIds(),
    );
    const staged = generateStagedPlan(plan, DENSE_GRADES);

    expect(staged.filter((slot) => slot.section === 'warmUp').every((slot) => slot.stageId === 'stage-0')).toBe(true);
    expect(staged.filter((slot) => slot.section !== 'warmUp').every((slot) => slot.stageId === 'stage-1')).toBe(true);
  });

  it('keeps the lowest-grade warm-up length (#6233)', () => {
    const plan = planFromBlocks(
      blocksFor({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'extended', targetGrade: 13 }),
      counterIds(),
    );
    const warmUpSlots = generateStagedPlan(plan, MOONBOARD_GRADES).filter((slot) => slot.section === 'warmUp');

    expect(warmUpSlots.map((slot) => slot.grade)).toEqual(Array(12).fill(13));
  });

  it('generates nothing for a warm-up with no stage after it', () => {
    const plan: WorkoutPlan = { stages: [{ id: 'warm', kind: 'warmUp', warmUpType: 'standard' }] };

    expect(generateStagedPlan(plan, DENSE_GRADES)).toEqual([]);
  });

  it('ramps two back-to-back warm-ups to the workout after them', () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'first', kind: 'warmUp', warmUpType: 'standard' },
        { id: 'second', kind: 'warmUp', warmUpType: 'standard' },
        {
          id: 'main',
          kind: 'gradeFocus',
          options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 10, numberOfClimbs: 2 },
        },
      ],
    };
    const staged = generateStagedPlan(plan, DENSE_GRADES);

    expect(staged.map((slot) => [slot.stageId, slot.grade, slot.index])).toEqual([
      ['first', 6, 0],
      ['first', 7, 1],
      ['first', 8, 2],
      ['first', 9, 3],
      ['second', 6, 4],
      ['second', 7, 5],
      ['second', 8, 6],
      ['second', 9, 7],
      ['main', 10, 8],
      ['main', 10, 9],
    ]);
  });

  it('falls back to its own target when it is the last stage', () => {
    const plan: WorkoutPlan = { stages: [{ id: 'warm', kind: 'warmUp', warmUpType: 'standard', targetGrade: 10 }] };

    expect(generateStagedPlan(plan, DENSE_GRADES)).toEqual(
      [6, 7, 8, 9].map((grade, index) => ({ grade, section: 'warmUp', index, stageId: 'warm' })),
    );
  });

  it('keeps its own target when another warm-up sits between it and the workout', () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'first', kind: 'warmUp', warmUpType: 'standard', targetGrade: 8 },
        { id: 'second', kind: 'warmUp', warmUpType: 'standard' },
        {
          id: 'main',
          kind: 'gradeFocus',
          options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 10, numberOfClimbs: 1 },
        },
      ],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => [slot.stageId, slot.grade])).toEqual([
      ['first', 4],
      ['first', 5],
      ['first', 6],
      ['first', 7],
      ['second', 6],
      ['second', 7],
      ['second', 8],
      ['second', 9],
      ['main', 10],
    ]);
  });

  // Partner warm-ups set their own range (docs/partner-api.md, "Blocks").
  it("keeps its own target over the following workout stage's", () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'warm', kind: 'warmUp', warmUpType: 'standard', targetGrade: 5 },
        {
          id: 'main',
          kind: 'gradeFocus',
          options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 10, numberOfClimbs: 1 },
        },
      ],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => slot.grade)).toEqual([1, 2, 3, 4, 10]);
  });

  it('ramps a warm-up to the top grade of a descending ladder after it', () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'warm', kind: 'warmUp', warmUpType: 'standard' },
        {
          id: 'ladder',
          kind: 'ladder',
          options: {
            ...DEFAULT_LADDER_OPTIONS,
            warmUp: 'none',
            descending: true,
            targetGrade: 20,
            numberOfSteps: 3,
            climbsPerStep: 1,
          },
        },
      ],
    };
    const staged = generateStagedPlan(plan, DENSE_GRADES);
    const warmUpGrades = staged.filter((slot) => slot.section === 'warmUp').map((slot) => slot.grade);
    const ladderGrades = staged.filter((slot) => slot.stageId === 'ladder').map((slot) => slot.grade);

    expect(warmUpGrades).toEqual([16, 17, 18, 19]);
    expect(ladderGrades).toEqual([20, 19, 18]);
    expect(staged.map((slot) => slot.index)).toEqual(staged.map((_, position) => position));
  });

  it('generates nothing for a workout stage whose kind does not match its options', () => {
    // Persisted data can drift from the types; it must not throw.
    const driftedStage = {
      id: 'drifted',
      kind: 'ladder',
      options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 10, numberOfClimbs: 3 },
    } as unknown as WorkoutStage;
    const plan: WorkoutPlan = {
      stages: [{ id: 'warm', kind: 'warmUp', warmUpType: 'standard' }, driftedStage],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES)).toEqual([]);
  });

  it('ignores a warm-up left in persisted workout-stage options', () => {
    const persistedStage = {
      id: 'main',
      kind: 'gradeFocus',
      options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'standard', targetGrade: 10, numberOfClimbs: 3 },
    } as unknown as WorkoutStage;
    const staged = generateStagedPlan({ stages: [persistedStage] }, DENSE_GRADES);

    expect(staged.map((slot) => slot.section)).toEqual(['main', 'main', 'main']);
  });

  it('runs the index across several workout stages', () => {
    const plan: WorkoutPlan = {
      stages: [
        {
          id: 'focus',
          kind: 'gradeFocus',
          options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 10, numberOfClimbs: 2 },
        },
        { id: 'warm', kind: 'warmUp', warmUpType: 'standard' },
        {
          id: 'ladder',
          kind: 'ladder',
          options: { ...DEFAULT_LADDER_OPTIONS, warmUp: 'none', targetGrade: 20, numberOfSteps: 2, climbsPerStep: 1 },
        },
      ],
    };
    const staged = generateStagedPlan(plan, DENSE_GRADES);

    expect(staged.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(staged.map((slot) => slot.stageId)).toEqual([
      'focus',
      'focus',
      'warm',
      'warm',
      'warm',
      'warm',
      'ladder',
      'ladder',
    ]);
    expect(staged.slice(2, 6).map((slot) => slot.grade)).toEqual([16, 17, 18, 19]);
  });
});

describe('generateStagedPlan cool-downs', () => {
  const volumeStage = (id: string, targetGrade: number, mainSetClimbs: number): WorkoutStage => ({
    id,
    kind: 'volume',
    options: { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade, mainSetClimbs },
  });

  it('steps a warm-up after a V5 volume block back down from V4 to V1', () => {
    const plan: WorkoutPlan = {
      stages: [volumeStage('main', 5, 3), { id: 'cool', kind: 'warmUp', warmUpType: 'standard' }],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES)).toEqual([
      { grade: 5, section: 'main', index: 0, stageId: 'main' },
      { grade: 5, section: 'main', index: 1, stageId: 'main' },
      { grade: 5, section: 'main', index: 2, stageId: 'main' },
      { grade: 4, section: 'coolDown', index: 3, stageId: 'cool' },
      { grade: 3, section: 'coolDown', index: 4, stageId: 'cool' },
      { grade: 2, section: 'coolDown', index: 5, stageId: 'cool' },
      { grade: 1, section: 'coolDown', index: 6, stageId: 'cool' },
    ]);
  });

  const coolDownGradesAfter = (stages: WorkoutStage[]) =>
    generateStagedPlan({ stages: [...stages, { id: 'cool', kind: 'warmUp', warmUpType: 'standard' }] }, DENSE_GRADES)
      .filter((slot) => slot.stageId === 'cool')
      .map((slot) => slot.grade);

  it('carries on down from where a pyramid ends, never climbing back up to its peak', () => {
    const pyramid: WorkoutStage = {
      id: 'main',
      kind: 'pyramid',
      options: { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', targetGrade: 15 },
    };
    const plan: WorkoutPlan = { stages: [pyramid, { id: 'cool', kind: 'warmUp', warmUpType: 'standard' }] };

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => `${slot.section}:${slot.grade}`)).toEqual([
      'increasing:13',
      'increasing:14',
      'peak:15',
      'decreasing:14',
      'decreasing:13',
      'coolDown:12',
      'coolDown:11',
      'coolDown:10',
      'coolDown:9',
    ]);
  });

  it('eases off from the top of a ladder, which ends on its target grade', () => {
    const ladder: WorkoutStage = {
      id: 'main',
      kind: 'ladder',
      options: { ...DEFAULT_LADDER_OPTIONS, warmUp: 'none', targetGrade: 15 },
    };

    expect(coolDownGradesAfter([ladder])).toEqual([14, 13, 12, 11]);
  });

  it('starts below the last climb of a volume block whose spread ended low', () => {
    // Every draw is the bottom of the spread: the block's climbs all land on V8.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const spread: WorkoutStage = {
      id: 'main',
      kind: 'volume',
      options: { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 10, mainSetClimbs: 2, mainSetVariability: 2 },
    };

    expect(coolDownGradesAfter([spread])).toEqual([7, 6, 5, 4]);
  });

  it("never starts above the block's grade when a volume spread ended high", () => {
    // Every draw is the top of the spread: the block's climbs all land on V12.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const spread: WorkoutStage = {
      id: 'main',
      kind: 'volume',
      options: { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 10, mainSetClimbs: 2, mainSetVariability: 2 },
    };

    expect(coolDownGradesAfter([spread])).toEqual([9, 8, 7, 6]);
  });

  it('eases off from the target grade of a block that planned no climbs', () => {
    expect(coolDownGradesAfter([volumeStage('main', 10, 0)])).toEqual([9, 8, 7, 6]);
  });

  it('leaves a warm-up between two blocks ramping up to the block after it', () => {
    const plan: WorkoutPlan = {
      stages: [
        volumeStage('first', 5, 1),
        { id: 'warm', kind: 'warmUp', warmUpType: 'standard' },
        volumeStage('second', 10, 1),
      ],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => [slot.stageId, slot.section, slot.grade])).toEqual([
      ['first', 'main', 5],
      ['warm', 'warmUp', 6],
      ['warm', 'warmUp', 7],
      ['warm', 'warmUp', 8],
      ['warm', 'warmUp', 9],
      ['second', 'main', 10],
    ]);
  });

  it('plans nothing for a warm-up with no workout on either side', () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'first', kind: 'warmUp', warmUpType: 'standard' },
        { id: 'second', kind: 'warmUp', warmUpType: 'extended' },
      ],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES)).toEqual([]);
  });

  it('eases two trailing warm-ups off from the last workout block, skipping the warm-up between', () => {
    const plan: WorkoutPlan = {
      stages: [
        volumeStage('first', 20, 1),
        volumeStage('last', 8, 1),
        { id: 'cool-1', kind: 'warmUp', warmUpType: 'standard' },
        { id: 'cool-2', kind: 'warmUp', warmUpType: 'standard' },
      ],
    };
    const coolDownGrades = (stageId: string) =>
      generateStagedPlan(plan, DENSE_GRADES)
        .filter((slot) => slot.stageId === stageId)
        .map((slot) => slot.grade);

    expect(coolDownGrades('cool-1')).toEqual([7, 6, 5, 4]);
    expect(coolDownGrades('cool-2')).toEqual([7, 6, 5, 4]);
  });

  it('eases off from the nearest workout stage it can run, past one whose kind drifted', () => {
    const driftedStage = {
      id: 'drifted',
      kind: 'ladder',
      options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 20, numberOfClimbs: 3 },
    } as unknown as WorkoutStage;
    const plan: WorkoutPlan = {
      stages: [volumeStage('main', 10, 1), driftedStage, { id: 'cool', kind: 'warmUp', warmUpType: 'standard' }],
    };

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => [slot.stageId, slot.grade])).toEqual([
      ['main', 10],
      ['cool', 9],
      ['cool', 8],
      ['cool', 7],
      ['cool', 6],
    ]);
  });

  // Partner warm-ups set their own range (docs/partner-api.md, "Blocks").
  it('keeps a trailing warm-up with its own target ramping up to it', () => {
    const plan: WorkoutPlan = {
      stages: [volumeStage('main', 10, 1), { id: 'warm', kind: 'warmUp', warmUpType: 'standard', targetGrade: 5 }],
    };

    expect(
      generateStagedPlan(plan, DENSE_GRADES)
        .filter((slot) => slot.stageId === 'warm')
        .map((slot) => [slot.section, slot.grade]),
    ).toEqual([
      ['warmUp', 1],
      ['warmUp', 2],
      ['warmUp', 3],
      ['warmUp', 4],
    ]);
  });

  it('eases off at the lowest grade with every climb at that grade, as a warm-up there would', () => {
    const plan: WorkoutPlan = {
      stages: [volumeStage('main', 13, 1), { id: 'cool', kind: 'warmUp', warmUpType: 'standard' }],
    };

    expect(
      generateStagedPlan(plan, MOONBOARD_GRADES)
        .filter((slot) => slot.stageId === 'cool')
        .map((slot) => slot.grade),
    ).toEqual([13, 13, 13, 13]);
  });
});

describe('planFromBlocks', () => {
  it('plans a warm-up block and a workout block as a warm-up stage then the workout', () => {
    const volume: GeneratorOptions = { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 18 };

    expect(planFromBlocks([{ kind: 'warmUp', warmUpType: 'extended' }, workoutBlock(volume)], counterIds())).toEqual({
      stages: [
        { id: 'stage-0', kind: 'warmUp', warmUpType: 'extended' },
        { id: 'stage-1', kind: 'volume', options: volume },
      ],
    });
  });

  it('plans one workout block as the workout alone', () => {
    const ladder: GeneratorOptions = { ...DEFAULT_LADDER_OPTIONS, warmUp: 'none', targetGrade: 12 };

    expect(planFromBlocks([workoutBlock(ladder)], counterIds())).toEqual({
      stages: [{ id: 'stage-0', kind: 'ladder', options: ladder }],
    });
  });

  it.each(EQUIVALENCE_CASES)(
    'a warm-up block plus a workout block generates what generateWorkoutPlan generates: $label',
    ({ options, grades }) => {
      seedRandom();
      const expected = generateWorkoutPlan(options, grades);
      vi.restoreAllMocks();
      seedRandom();
      const staged = generateStagedPlan(planFromBlocks(blocksFor(options), counterIds()), grades);

      expect(withoutStageId(staged)).toEqual(expected);
    },
  );

  it('keeps a warm-up wherever it sits, as often as it appears', () => {
    const pyramid: GeneratorOptions = { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', targetGrade: 20 };
    const volume: GeneratorOptions = { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 16 };
    const plan = planFromBlocks(
      [
        workoutBlock(pyramid),
        { kind: 'warmUp', warmUpType: 'standard' },
        workoutBlock(volume),
        { kind: 'warmUp', warmUpType: 'extended' },
      ],
      counterIds(),
    );

    expect(plan).toEqual({
      stages: [
        { id: 'stage-0', kind: 'pyramid', options: pyramid },
        { id: 'stage-1', kind: 'warmUp', warmUpType: 'standard' },
        { id: 'stage-2', kind: 'volume', options: volume },
        { id: 'stage-3', kind: 'warmUp', warmUpType: 'extended' },
      ],
    });
  });

  it("ignores a workout block's own warm-up: warm-ups are blocks of their own", () => {
    const plan = planFromBlocks(
      [
        workoutBlock({ ...DEFAULT_LADDER_OPTIONS, warmUp: 'extended', targetGrade: 18 }),
        workoutBlock({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'standard', targetGrade: 12 }),
      ],
      counterIds(),
    );

    expect(plan.stages.map((stage) => stage.kind)).toEqual(['ladder', 'gradeFocus']);
    expect(plan.stages.every((stage) => stage.kind === 'warmUp' || stage.options.warmUp === 'none')).toBe(true);
  });

  it('gives an empty plan for no blocks', () => {
    expect(planFromBlocks([], counterIds())).toEqual({ stages: [] });
  });

  it('takes every id from the injected factory', () => {
    const makeId = vi.fn((stagePosition: number) => `uuid-${stagePosition * 10}`);
    const plan = planFromBlocks(
      [
        { kind: 'warmUp', warmUpType: 'standard' },
        workoutBlock({ ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 10 }),
        workoutBlock({ ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 10 }),
      ],
      makeId,
    );

    expect(plan.stages.map((stage) => stage.id)).toEqual(['uuid-0', 'uuid-10', 'uuid-20']);
    expect(makeId).toHaveBeenCalledTimes(3);
  });

  it('keeps ids unique when two plans share one id factory', () => {
    const makeId = counterIds();
    const first = planFromBlocks(blocksFor({ ...DEFAULT_VOLUME_OPTIONS, warmUp: 'standard', targetGrade: 18 }), makeId);
    const second = planFromBlocks(
      blocksFor({ ...DEFAULT_LADDER_OPTIONS, warmUp: 'standard', targetGrade: 18 }),
      makeId,
    );
    const joinedIds = [...first.stages, ...second.stages].map((stage) => stage.id);

    expect(new Set(joinedIds).size).toBe(joinedIds.length);
  });

  it('survives a JSON round trip', () => {
    const plan = planFromBlocks(
      blocksFor({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'standard', targetGrade: 18 }),
      counterIds(),
    );

    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('does not mutate the options it was given', () => {
    const options: GeneratorOptions = { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'standard', targetGrade: 18 };
    planFromBlocks([workoutBlock(options)], counterIds());

    expect(options.warmUp).toBe('standard');
  });

  it("ramps a warm-up in the middle to the next block's grade and runs the index across every block", () => {
    const plan = planFromBlocks(
      [
        workoutBlock({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 12, numberOfClimbs: 1 }),
        { kind: 'warmUp', warmUpType: 'standard' },
        workoutBlock({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 20, numberOfClimbs: 2 }),
      ],
      counterIds(),
    );
    const staged = generateStagedPlan(plan, DENSE_GRADES);

    expect(staged.map((slot) => [slot.stageId, slot.grade, slot.index])).toEqual([
      ['stage-0', 12, 0],
      ['stage-1', 16, 1],
      ['stage-1', 17, 2],
      ['stage-1', 18, 3],
      ['stage-1', 19, 4],
      ['stage-2', 20, 5],
      ['stage-2', 20, 6],
    ]);
  });

  it("gives each stage its block's filters, and leaves them off a block without any", () => {
    const volume: GeneratorOptions = { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 16 };
    const plan = planFromBlocks(
      [
        { kind: 'warmUp', warmUpType: 'standard', filters: STRICT_FILTERS },
        { kind: 'workout', options: volume, filters: { ...STRICT_FILTERS, climbBias: 'attempted' } },
        workoutBlock(volume),
      ],
      counterIds(),
    );

    expect(plan.stages[0].filters).toEqual(STRICT_FILTERS);
    expect(plan.stages[1].filters).toEqual({ ...STRICT_FILTERS, climbBias: 'attempted' });
    expect('filters' in plan.stages[2]).toBe(false);
  });

  it('plans the same slots whatever the filters', () => {
    const pyramid: GeneratorOptions = { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', targetGrade: 20 };
    const plain = generateStagedPlan(planFromBlocks([workoutBlock(pyramid)], counterIds()), DENSE_GRADES);
    const filtered = generateStagedPlan(
      planFromBlocks([{ kind: 'workout', options: pyramid, filters: STRICT_FILTERS }], counterIds()),
      DENSE_GRADES,
    );

    expect(filtered).toEqual(plain);
  });

  it('eases a warm-up after the last workout block off from that block, and plans nothing for a lone warm-up', () => {
    const plan = planFromBlocks(
      [
        workoutBlock({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 12, numberOfClimbs: 1 }),
        { kind: 'warmUp', warmUpType: 'extended' },
      ],
      counterIds(),
    );

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => [slot.stageId, slot.section, slot.grade])).toEqual([
      ['stage-0', 'main', 12],
      ...[11, 11, 10, 10, 9, 9, 8, 8, 7, 7, 6, 6].map((grade) => ['stage-1', 'coolDown', grade]),
    ]);
    expect(
      generateStagedPlan(planFromBlocks([{ kind: 'warmUp', warmUpType: 'standard' }], counterIds()), DENSE_GRADES),
    ).toEqual([]);
  });
});

const PLAN: WorkoutPlan = planFromBlocks(
  blocksFor({ ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'standard', targetGrade: 18 }),
  counterIds(),
);

describe('buildWorkoutRun', () => {
  it('groups uuids by stage in plan order, keeping entry order within a stage', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'p1', stageId: 'stage-1' },
        { uuid: 'w1', stageId: 'stage-0' },
        { uuid: 'p2', stageId: 'stage-1' },
        { uuid: 'w2', stageId: 'stage-0' },
      ],
      PLAN,
    );

    expect(run).toEqual({
      stages: [
        { id: 'stage-0', kind: 'warmUp', itemUuids: ['w1', 'w2'] },
        { id: 'stage-1', kind: 'pyramid', itemUuids: ['p1', 'p2'], targetGrade: 18 },
      ],
    });
  });

  it('keeps a uuid in the first stage that claims it', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'w1', stageId: 'stage-0' },
        { uuid: 'w1', stageId: 'stage-1' },
        { uuid: 'p1', stageId: 'stage-1' },
      ],
      PLAN,
    );

    expect(run).toEqual({
      stages: [
        { id: 'stage-0', kind: 'warmUp', itemUuids: ['w1'] },
        { id: 'stage-1', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 },
      ],
    });
  });

  it('lets a known stage claim a uuid an unknown stage named first', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'p1', stageId: 'gone' },
        { uuid: 'p1', stageId: 'stage-1' },
      ],
      PLAN,
    );

    expect(run).toEqual({ stages: [{ id: 'stage-1', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 }] });
  });

  it('skips stages with no items and entries for unknown stages', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'p1', stageId: 'stage-1' },
        { uuid: 'x1', stageId: 'gone' },
      ],
      PLAN,
    );

    expect(run).toEqual({ stages: [{ id: 'stage-1', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 }] });
  });

  it('emits a stage id repeated in the plan only once', () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'dup', kind: 'warmUp', warmUpType: 'standard' },
        {
          id: 'dup',
          kind: 'gradeFocus',
          options: { ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 10, numberOfClimbs: 1 },
        },
      ],
    };
    const run = buildWorkoutRun([{ uuid: 'x1', stageId: 'dup' }], plan);

    expect(run).toEqual({ stages: [{ id: 'dup', kind: 'warmUp', itemUuids: ['x1'] }] });
  });

  it('returns an empty run for no entries', () => {
    expect(buildWorkoutRun([], PLAN)).toEqual({ stages: [] });
  });

  it("keeps every stage's filters, warm-ups included", () => {
    const plan = planFromBlocks(
      [
        { kind: 'warmUp', warmUpType: 'standard', filters: STRICT_FILTERS },
        {
          kind: 'workout',
          options: { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade: 16 },
          filters: { ...STRICT_FILTERS, minRating: 0 },
        },
      ],
      counterIds(),
    );
    const run = buildWorkoutRun(
      [
        { uuid: 'w1', stageId: 'stage-0' },
        { uuid: 'v1', stageId: 'stage-1' },
      ],
      plan,
    );

    expect(run).toEqual({
      stages: [
        { id: 'stage-0', kind: 'warmUp', itemUuids: ['w1'], filters: STRICT_FILTERS },
        {
          id: 'stage-1',
          kind: 'volume',
          itemUuids: ['v1'],
          targetGrade: 16,
          filters: { ...STRICT_FILTERS, minRating: 0 },
        },
      ],
    });
  });
});

const RUN: WorkoutRun = {
  stages: [
    { id: 'stage-0', kind: 'warmUp', itemUuids: ['w1', 'w2'] },
    { id: 'stage-1', kind: 'pyramid', itemUuids: ['p1', 'p2', 'p3'] },
  ],
};

describe('appendStageToRun', () => {
  it('adds a new stage at the end without touching the input', () => {
    const snapshot = structuredClone(RUN);
    const next = appendStageToRun(RUN, { id: 'stage-2', kind: 'gradeFocus' }, ['g1', 'g2']);

    expect(next.stages.map((stage) => stage.id)).toEqual(['stage-0', 'stage-1', 'stage-2']);
    expect(next.stages[2]).toEqual({ id: 'stage-2', kind: 'gradeFocus', itemUuids: ['g1', 'g2'] });
    expect(RUN).toEqual(snapshot);
  });

  it('appends to a stage that is already in the run', () => {
    const next = appendStageToRun(RUN, { id: 'stage-1', kind: 'pyramid' }, ['p4']);

    expect(next.stages[1].itemUuids).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(RUN.stages[1].itemUuids).toEqual(['p1', 'p2', 'p3']);
  });

  it('throws when the id is already used by a stage of another kind', () => {
    expect(() => appendStageToRun(RUN, { id: 'stage-1', kind: 'volume' }, ['v1'])).toThrow(/stage-1/);
  });

  it('skips uuids already in the run and duplicates in the input', () => {
    const next = appendStageToRun(RUN, { id: 'stage-2', kind: 'volume' }, ['w1', 'v1', 'v1']);

    expect(next.stages[2].itemUuids).toEqual(['v1']);
  });

  it('keeps the target grade of a new stage, and leaves it off when none is given', () => {
    const graded = appendStageToRun(RUN, { id: 'stage-2', kind: 'ladder', targetGrade: 21 }, ['l1']);
    expect(graded.stages[2]).toEqual({ id: 'stage-2', kind: 'ladder', itemUuids: ['l1'], targetGrade: 21 });

    const ungraded = appendStageToRun(RUN, { id: 'stage-2', kind: 'ladder' }, ['l1']);
    expect('targetGrade' in ungraded.stages[2]).toBe(false);
  });

  it('keeps the filters of a new stage, and leaves them off when none are given', () => {
    const filtered = appendStageToRun(RUN, { id: 'stage-2', kind: 'volume', filters: STRICT_FILTERS }, ['v1']);
    expect(filtered.stages[2]).toEqual({ id: 'stage-2', kind: 'volume', itemUuids: ['v1'], filters: STRICT_FILTERS });

    const unfiltered = appendStageToRun(RUN, { id: 'stage-2', kind: 'volume' }, ['v1']);
    expect('filters' in unfiltered.stages[2]).toBe(false);
  });

  it('starts the round map of an existing stage that had none from the appended climbs', () => {
    const noRounds: WorkoutRun = { stages: [{ id: 'four', kind: 'fourByFour', itemUuids: ['a', 'b'] }] };
    const next = appendStageToRun(
      noRounds,
      { id: 'four', kind: 'fourByFour', roundByUuid: { c: 2, d: 2, unrelated: 3 } },
      ['c', 'd'],
    );

    expect(next).toEqual({
      stages: [{ id: 'four', kind: 'fourByFour', itemUuids: ['a', 'b', 'c', 'd'], roundByUuid: { c: 2, d: 2 } }],
    });
    expect('roundByUuid' in noRounds.stages[0]).toBe(false);
  });

  it('returns the same run when there is nothing to add', () => {
    expect(appendStageToRun(RUN, { id: 'stage-2', kind: 'volume' }, [])).toBe(RUN);
    expect(appendStageToRun(RUN, { id: 'stage-2', kind: 'volume' }, ['p1'])).toBe(RUN);
  });
});

describe('pruneRun', () => {
  it('returns the same object when every uuid is still queued', () => {
    expect(pruneRun(RUN, ['w1', 'w2', 'p1', 'p2', 'p3', 'other'])).toBe(RUN);
  });

  it('drops a removed item, including the current one', () => {
    const next = pruneRun(RUN, ['w1', 'w2', 'p1', 'p3']);

    expect(next.stages[1].itemUuids).toEqual(['p1', 'p3']);
    expect(next.stages[0]).toBe(RUN.stages[0]);
    expect(RUN.stages[1].itemUuids).toEqual(['p1', 'p2', 'p3']);
  });

  it('drops a stage left empty', () => {
    const next = pruneRun(RUN, ['p1', 'p2', 'p3']);

    expect(next.stages.map((stage) => stage.id)).toEqual(['stage-1']);
  });

  it('empties the run when none of its climbs are left in a non-empty queue', () => {
    expect(pruneRun(RUN, ['unknown'])).toEqual({ stages: [] });
  });

  it('leaves the run alone while the queue is empty (hydration or session sync)', () => {
    expect(pruneRun(RUN, [])).toBe(RUN);
  });
});

describe('locateInRun', () => {
  const QUEUE = ['w1', 'w2', 'p1', 'p2', 'p3'];

  it('locates the first climb', () => {
    expect(locateInRun(RUN, 'w1', QUEUE)).toEqual({
      stageIndex: 0,
      stageCount: 2,
      stageId: 'stage-0',
      kind: 'warmUp',
      positionInStage: 1,
      stageSize: 2,
      remainingInStage: 1,
    });
  });

  it('locates a middle climb', () => {
    expect(locateInRun(RUN, 'p2', QUEUE)).toMatchObject({
      stageIndex: 1,
      stageId: 'stage-1',
      kind: 'pyramid',
      positionInStage: 2,
      stageSize: 3,
      remainingInStage: 1,
    });
  });

  it('locates the last climb', () => {
    expect(locateInRun(RUN, 'p3', QUEUE)).toMatchObject({ positionInStage: 3, stageSize: 3, remainingInStage: 0 });
  });

  it('follows the queue order after a reorder', () => {
    const reordered = ['w1', 'w2', 'p3', 'p1', 'p2'];

    expect(locateInRun(RUN, 'p3', reordered)).toMatchObject({ positionInStage: 1, remainingInStage: 2 });
    expect(locateInRun(RUN, 'p2', reordered)).toMatchObject({ positionInStage: 3, remainingInStage: 0 });
  });

  it('orders stages by where their first climb sits in the queue', () => {
    const stagesSwapped = ['p1', 'p2', 'p3', 'w1', 'w2'];

    expect(locateInRun(RUN, 'p1', stagesSwapped)).toMatchObject({ stageIndex: 0, stageId: 'stage-1' });
    expect(locateInRun(RUN, 'w2', stagesSwapped)).toMatchObject({
      stageIndex: 1,
      stageCount: 2,
      stageId: 'stage-0',
      positionInStage: 2,
      remainingInStage: 0,
    });
  });

  it('ignores climbs that left the queue', () => {
    expect(locateInRun(RUN, 'p3', ['p1', 'p3'])).toEqual({
      stageIndex: 0,
      stageCount: 1,
      stageId: 'stage-1',
      kind: 'pyramid',
      positionInStage: 2,
      stageSize: 2,
      remainingInStage: 0,
    });
  });

  it('returns null for a uuid in no stage', () => {
    expect(locateInRun(RUN, 'extra', [...QUEUE, 'extra'])).toBeNull();
  });

  it('returns null for a uuid that is not queued', () => {
    expect(locateInRun(RUN, 'p1', ['w1'])).toBeNull();
  });

  it('returns null for an empty run', () => {
    expect(locateInRun({ stages: [] }, 'w1', QUEUE)).toBeNull();
  });
});

describe('the run marks cool-downs', () => {
  const volumeStage = (id: string, targetGrade: number): WorkoutStage => ({
    id,
    kind: 'volume',
    options: { ...DEFAULT_VOLUME_OPTIONS, warmUp: 'none', targetGrade, mainSetClimbs: 1 },
  });
  const entriesFor = (plan: WorkoutPlan): WorkoutRunEntry[] =>
    plan.stages.map((stage) => ({ uuid: `${stage.id}-1`, stageId: stage.id }));

  it('marks a warm-up after the last workout stage, and no other stage', () => {
    const plan: WorkoutPlan = {
      stages: [
        { id: 'warm', kind: 'warmUp', warmUpType: 'standard' },
        volumeStage('main', 10),
        { id: 'cool', kind: 'warmUp', warmUpType: 'standard' },
      ],
    };

    expect(buildWorkoutRun(entriesFor(plan), plan).stages.map((stage) => [stage.id, stage.coolDown])).toEqual([
      ['warm', undefined],
      ['main', undefined],
      ['cool', true],
    ]);
  });

  it('leaves a trailing warm-up with its own target unmarked: it ramps up to it', () => {
    const plan: WorkoutPlan = {
      stages: [volumeStage('main', 10), { id: 'warm', kind: 'warmUp', warmUpType: 'standard', targetGrade: 12 }],
    };

    expect(buildWorkoutRun(entriesFor(plan), plan).stages[1]).toEqual({
      id: 'warm',
      kind: 'warmUp',
      itemUuids: ['warm-1'],
    });
  });

  it('keeps the mark on a stage appended to a run', () => {
    const next = appendStageToRun({ stages: [] }, { id: 'cool', kind: 'warmUp', coolDown: true }, ['c1']);

    expect(next.stages).toEqual([{ id: 'cool', kind: 'warmUp', itemUuids: ['c1'], coolDown: true }]);
  });
});

describe('locateInRun cool-downs', () => {
  const COOL_RUN: WorkoutRun = {
    stages: [
      { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
      { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] },
      { id: 'cool', kind: 'warmUp', itemUuids: ['c1', 'c2'], coolDown: true },
    ],
  };
  const COOL_QUEUE = ['w1', 'm1', 'm2', 'c1', 'c2'];

  it('flags a climb of a stage planned as a cool-down', () => {
    expect(locateInRun(COOL_RUN, 'c2', COOL_QUEUE)).toEqual({
      stageIndex: 2,
      stageCount: 3,
      stageId: 'cool',
      kind: 'warmUp',
      positionInStage: 2,
      stageSize: 2,
      remainingInStage: 0,
      isCoolDown: true,
    });
  });

  it('leaves the flag off a warm-up before a workout stage, and off every workout stage', () => {
    expect(locateInRun(COOL_RUN, 'w1', COOL_QUEUE)).not.toHaveProperty('isCoolDown');
    expect(locateInRun(COOL_RUN, 'm1', COOL_QUEUE)).not.toHaveProperty('isCoolDown');
  });

  it('leaves the flag off a warm-up that was not planned as one, wherever it is queued', () => {
    // A warm-up the climber dragged behind the workout, or a partner warm-up
    // with its own target: both ramp up, so neither reads "Cool-down".
    const rampsUp: WorkoutRun = {
      stages: [
        { id: 'main', kind: 'volume', itemUuids: ['m1'] },
        { id: 'warm', kind: 'warmUp', itemUuids: ['w1', 'w2'] },
      ],
    };

    expect(locateInRun(rampsUp, 'w1', ['m1', 'w1', 'w2'])).not.toHaveProperty('isCoolDown');
  });

  it('keeps the flag when the climber queues the cool-down before the workout', () => {
    expect(locateInRun(COOL_RUN, 'c1', ['c1', 'c2', 'w1', 'm1', 'm2'])).toMatchObject({
      stageIndex: 0,
      isCoolDown: true,
    });
  });

  it('keeps the flag once a block added mid-session lands after the cool-down', () => {
    const extended = appendStageToRun(COOL_RUN, { id: 'more', kind: 'pyramid', targetGrade: 10 }, ['p1']);

    expect(locateInRun(extended, 'c1', [...COOL_QUEUE, 'p1'])).toMatchObject({ stageId: 'cool', isCoolDown: true });
    expect(locateInRun(extended, 'p1', [...COOL_QUEUE, 'p1'])).not.toHaveProperty('isCoolDown');
  });

  it('ignores the mark on a workout stage', () => {
    // Persisted data can drift: only a warm-up reads as a cool-down.
    const drifted: WorkoutRun = { stages: [{ id: 'main', kind: 'volume', itemUuids: ['m1'], coolDown: true }] };

    expect(locateInRun(drifted, 'm1', ['m1'])).not.toHaveProperty('isCoolDown');
  });
});

describe('stage kinds', () => {
  it('lists every kind, the partner block names for the timed ones included', () => {
    expect([...WORKOUT_STAGE_KINDS]).toEqual([
      'warmUp',
      'volume',
      'pyramid',
      'ladder',
      'gradeFocus',
      'onTheMinute',
      'fourByFour',
      'limitBouldering',
    ]);
  });

  it('knows only those kinds', () => {
    expect(WORKOUT_STAGE_KINDS.every(isWorkoutStageKind)).toBe(true);
    for (const candidate of ['freeClimbing', 'FourByFour', '', 'constructor', 'toString', 4, null, undefined]) {
      expect(isWorkoutStageKind(candidate)).toBe(false);
    }
  });

  it.each([
    { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 18 },
    { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18 },
    { ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 18 },
  ] satisfies GeneratorOptions[])('plans a $type block as a stage of that kind', (options) => {
    const plan = planFromBlocks([workoutBlock({ ...options, warmUp: 'extended' })], counterIds());

    expect(plan.stages).toEqual([{ id: 'stage-0', kind: options.type, options: { ...options, warmUp: 'none' } }]);
  });

  it('plans one slot per climb of a 4x4 round, never one per round', () => {
    const plan = planFromBlocks(
      [workoutBlock({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18, climbsPerRound: 4, rounds: 4 })],
      counterIds(),
    );

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => slot.grade)).toEqual([18, 18, 18, 18]);
  });
});

const FOUR_BY_FOUR_PACING: WorkoutStagePacing = {
  mode: 'afterTick',
  restSeconds: 0,
  restBetweenRoundsSeconds: 180,
  advanceOn: 'tick',
};

describe('the run carries pacing and rounds', () => {
  const timedPlan = planFromBlocks(
    [
      { kind: 'warmUp', warmUpType: 'standard' },
      workoutBlock({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18, climbsPerRound: 2, rounds: 3 }),
      workoutBlock({ ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 22 }),
      workoutBlock({ ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 16, intervalSeconds: 75 }),
    ],
    counterIds(),
  );
  // What Start would hand over: the 4x4's two climbs queued for three rounds.
  const fourByFourEntries: WorkoutRunEntry[] = expandRounds(
    [
      { uuid: 'a', stageId: 'stage-1' },
      { uuid: 'b', stageId: 'stage-1' },
    ],
    3,
    (entry, round) => ({ ...entry, uuid: `${entry.uuid}${round}` }),
  ).map(({ item, round }) => ({ ...item, round }));
  const entries: WorkoutRunEntry[] = [
    { uuid: 'w1', stageId: 'stage-0' },
    ...fourByFourEntries,
    { uuid: 'l1', stageId: 'stage-2' },
    { uuid: 'm1', stageId: 'stage-3' },
  ];

  it('derives each stage’s pacing from its options and keeps every round', () => {
    expect(buildWorkoutRun(entries, timedPlan)).toEqual({
      stages: [
        { id: 'stage-0', kind: 'warmUp', itemUuids: ['w1'] },
        {
          id: 'stage-1',
          kind: 'fourByFour',
          itemUuids: ['a', 'b', 'a2', 'b2', 'a3', 'b3'],
          targetGrade: 18,
          pacing: FOUR_BY_FOUR_PACING,
          rounds: 3,
          roundByUuid: { a: 1, b: 1, a2: 2, b2: 2, a3: 3, b3: 3 },
        },
        {
          id: 'stage-2',
          kind: 'limitBouldering',
          itemUuids: ['l1'],
          targetGrade: 22,
          pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
        },
        {
          id: 'stage-3',
          kind: 'onTheMinute',
          itemUuids: ['m1'],
          targetGrade: 16,
          pacing: { mode: 'onTheMinute', restSeconds: 75 },
        },
      ],
    });
  });

  it('leaves the new fields off every untimed stage', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'w1', stageId: 'stage-0' },
        { uuid: 'p1', stageId: 'stage-1' },
      ],
      PLAN,
    );

    for (const stage of run.stages) {
      expect(['pacing', 'rounds', 'roundByUuid'].filter((field) => field in stage)).toEqual([]);
    }
    expect(workoutRunHasPacing(run)).toBe(false);
  });

  it('keeps rounds on any stage its entries name them for, and drops broken ones', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'p1', stageId: 'stage-1', round: 1 },
        { uuid: 'p2', stageId: 'stage-1', round: 2 },
        { uuid: 'p3', stageId: 'stage-1', round: 0 },
        { uuid: 'p4', stageId: 'stage-1', round: 1.5 },
      ],
      PLAN,
    );

    expect(run.stages[0].roundByUuid).toEqual({ p1: 1, p2: 2 });
    expect('rounds' in run.stages[0]).toBe(false);
  });

  it('gives a round only to the stage that claims its uuid', () => {
    const run = buildWorkoutRun(
      [
        { uuid: 'x', stageId: 'stage-0' },
        { uuid: 'x', stageId: 'stage-1', round: 2 },
      ],
      PLAN,
    );

    expect(run.stages).toEqual([{ id: 'stage-0', kind: 'warmUp', itemUuids: ['x'] }]);
  });

  it('survives a JSON round trip', () => {
    const run = buildWorkoutRun(entries, timedPlan);

    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
  });

  it('says whether any stage paces the rest timer', () => {
    expect(workoutRunHasPacing(buildWorkoutRun(entries, timedPlan))).toBe(true);
    expect(workoutRunHasPacing({ stages: [] })).toBe(false);
  });
});

const ROUNDS_RUN: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'four',
      kind: 'fourByFour',
      itemUuids: ['a', 'b', 'a2', 'b2'],
      targetGrade: 18,
      pacing: FOUR_BY_FOUR_PACING,
      rounds: 2,
      roundByUuid: { a: 1, b: 1, a2: 2, b2: 2 },
    },
  ],
};

describe('appendStageToRun with pacing and rounds', () => {
  it('gives a new stage its pacing, rounds and the rounds of the climbs it adds', () => {
    const next = appendStageToRun(
      { stages: [] },
      { ...ROUNDS_RUN.stages[1], roundByUuid: { a: 1, b: 1, a2: 2, b2: 2, gone: 2 } },
      ['a', 'a2', 'a'],
    );

    expect(next.stages).toEqual([
      {
        id: 'four',
        kind: 'fourByFour',
        itemUuids: ['a', 'a2'],
        targetGrade: 18,
        pacing: FOUR_BY_FOUR_PACING,
        rounds: 2,
        roundByUuid: { a: 1, a2: 2 },
      },
    ]);
  });

  it('merges the added climbs’ rounds into a stage already in the run, keeping its own pacing', () => {
    const snapshot = structuredClone(ROUNDS_RUN);
    const next = appendStageToRun(
      ROUNDS_RUN,
      {
        id: 'four',
        kind: 'fourByFour',
        pacing: { mode: 'afterTick', restSeconds: 60, advanceOn: 'tick' },
        roundByUuid: { a3: 3, b3: 3, a: 9 },
      },
      ['a3', 'b3', 'a'],
    );

    expect(next.stages[1]).toEqual({
      ...ROUNDS_RUN.stages[1],
      itemUuids: ['a', 'b', 'a2', 'b2', 'a3', 'b3'],
      roundByUuid: { a: 1, b: 1, a2: 2, b2: 2, a3: 3, b3: 3 },
    });
    expect(ROUNDS_RUN).toEqual(snapshot);
  });

  it('leaves the new fields off a stage given none', () => {
    const next = appendStageToRun(RUN, { id: 'stage-2', kind: 'volume' }, ['v1']);

    expect(next.stages[2]).toEqual({ id: 'stage-2', kind: 'volume', itemUuids: ['v1'] });
  });

  it('leaves roundByUuid off when none of the added climbs has a round', () => {
    const next = appendStageToRun(RUN, { id: 'stage-2', kind: 'fourByFour', roundByUuid: { other: 1 } }, ['v1']);

    expect('roundByUuid' in next.stages[2]).toBe(false);
  });
});

describe('pruneRun with rounds', () => {
  it('drops the rounds of climbs that left the queue', () => {
    const next = pruneRun(ROUNDS_RUN, ['w1', 'a', 'a2', 'b2']);

    expect(next.stages[1]).toEqual({
      ...ROUNDS_RUN.stages[1],
      itemUuids: ['a', 'a2', 'b2'],
      roundByUuid: { a: 1, a2: 2, b2: 2 },
    });
    expect(next.stages[0]).toBe(ROUNDS_RUN.stages[0]);
  });

  it('keeps the same run when every climb is still queued', () => {
    expect(pruneRun(ROUNDS_RUN, ['w1', 'a', 'b', 'a2', 'b2'])).toBe(ROUNDS_RUN);
  });

  it('leaves roundByUuid off a stage whose climbs with rounds are all gone', () => {
    const run: WorkoutRun = {
      stages: [{ id: 's', kind: 'gradeFocus', itemUuids: ['g1', 'g2'], roundByUuid: { g1: 1 } }],
    };

    expect(pruneRun(run, ['g2'])).toEqual({ stages: [{ id: 's', kind: 'gradeFocus', itemUuids: ['g2'] }] });
  });
});

describe('locateInRun with rounds', () => {
  const QUEUE = ['w1', 'a', 'b', 'a2', 'b2'];

  it('places the current climb in its round', () => {
    expect(locateInRun(ROUNDS_RUN, 'a2', QUEUE)).toEqual({
      stageIndex: 1,
      stageCount: 2,
      stageId: 'four',
      kind: 'fourByFour',
      positionInStage: 3,
      stageSize: 4,
      remainingInStage: 1,
      round: { round: 2, roundCount: 2, positionInRound: 1, roundSize: 2 },
    });
  });

  it('keeps each climb’s stored round when the queue is reordered or trimmed', () => {
    expect(locateInRun(ROUNDS_RUN, 'b', ['w1', 'a2', 'b', 'a', 'b2'])?.round).toEqual({
      round: 1,
      roundCount: 2,
      positionInRound: 1,
      roundSize: 2,
    });
    expect(locateInRun(ROUNDS_RUN, 'b2', ['a2', 'b2'])?.round).toEqual({
      round: 1,
      roundCount: 1,
      positionInRound: 2,
      roundSize: 2,
    });
  });

  it('gives no round to a climb without one, rounds or not in its stage', () => {
    expect('round' in (locateInRun(ROUNDS_RUN, 'w1', QUEUE) ?? {})).toBe(false);
    expect('round' in (locateInRun(RUN, 'p2', ['w1', 'w2', 'p1', 'p2', 'p3']) ?? {})).toBe(false);
  });
});
