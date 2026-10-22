import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorGradeScale,
  type GeneratorOptions,
  type StagedSlot,
  WARM_UP_OPTIONS,
  type WorkoutPlan,
  type WorkoutRun,
  type WorkoutBlockSpec,
  type WorkoutStage,
  type WorkoutStageFilters,
  appendStageToRun,
  buildWorkoutRun,
  generateStagedPlan,
  generateWorkoutPlan,
  locateInRun,
  planFromBlocks,
  pruneRun,
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

  it('plans no climbs for a warm-up with no workout block after it', () => {
    const plan = planFromBlocks(
      [
        workoutBlock({ ...DEFAULT_GRADE_FOCUS_OPTIONS, warmUp: 'none', targetGrade: 12, numberOfClimbs: 1 }),
        { kind: 'warmUp', warmUpType: 'extended' },
      ],
      counterIds(),
    );

    expect(generateStagedPlan(plan, DENSE_GRADES).map((slot) => slot.stageId)).toEqual(['stage-0']);
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
