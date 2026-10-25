import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  type GeneratorOptions,
  MAX_STAGE_REPS_PER_SET,
  MAX_STAGE_REST_SECONDS,
  MIN_STAGE_INTERVAL_SECONDS,
  MIN_STAGE_REPS_PER_SET,
  STAGE_CHANGEOVER_SECONDS,
  TIMED_WORKOUT_TYPES,
  type WorkoutStagePacing,
  isWorkoutStagePacing,
  pacingForOptions,
  stageRestSeconds,
} from '../index';

const onTheMinute = { ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 18 };
const fourByFour = { ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 18 };
const limitBouldering = { ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 22 };
const UNTIMED_OPTIONS: GeneratorOptions[] = [
  { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 18 },
  { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 },
  { ...DEFAULT_LADDER_OPTIONS, targetGrade: 18 },
  { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 18 },
];

describe('pacingForOptions', () => {
  it('paces on the minute with the interval', () => {
    expect(pacingForOptions(onTheMinute)).toEqual({ mode: 'onTheMinute', restSeconds: 60 });
  });

  it('paces a 4x4 by its sets: reps per climb, the rest between reps and the rest between sets', () => {
    expect(pacingForOptions(fourByFour)).toEqual({
      mode: 'afterTick',
      restSeconds: 0,
      advanceOn: 'set',
      sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
    });
    expect(
      pacingForOptions({ ...fourByFour, repsPerSet: 3, restBetweenRepsSeconds: 45, restBetweenSetsSeconds: 300 }),
    ).toEqual({
      mode: 'afterTick',
      restSeconds: 45,
      advanceOn: 'set',
      sets: { repsPerSet: 3, restBetweenSetsSeconds: 300 },
    });
  });

  it('paces limit bouldering after each tick, moving on only after a send', () => {
    expect(pacingForOptions(limitBouldering)).toEqual({ mode: 'afterTick', restSeconds: 180, advanceOn: 'send' });
  });

  it.each(UNTIMED_OPTIONS)('leaves $type to the global rest settings', (options) => {
    expect(pacingForOptions(options)).toBeUndefined();
  });

  it('paces exactly the timed types', () => {
    const allOptions: GeneratorOptions[] = [...UNTIMED_OPTIONS, onTheMinute, fourByFour, limitBouldering];
    const paced = allOptions
      .filter((options) => pacingForOptions(options) !== undefined)
      .map((options) => options.type);

    expect(paced).toEqual([...TIMED_WORKOUT_TYPES]);
  });

  it('rounds and clamps seconds into range, so the run never stores pacing it cannot read back', () => {
    expect(pacingForOptions({ ...onTheMinute, intervalSeconds: 5 })).toEqual({
      mode: 'onTheMinute',
      restSeconds: MIN_STAGE_INTERVAL_SECONDS,
    });
    expect(pacingForOptions({ ...onTheMinute, intervalSeconds: 9000 })).toMatchObject({
      restSeconds: MAX_STAGE_REST_SECONDS,
    });
    expect(pacingForOptions({ ...fourByFour, restBetweenRepsSeconds: -4, restBetweenSetsSeconds: 90.6 })).toMatchObject(
      { restSeconds: 0, sets: { restBetweenSetsSeconds: 91 } },
    );
    expect(pacingForOptions({ ...limitBouldering, restSeconds: Number.NaN })).toMatchObject({ restSeconds: 0 });

    const odd: GeneratorOptions[] = [
      { ...onTheMinute, intervalSeconds: Number.POSITIVE_INFINITY },
      { ...fourByFour, restBetweenSetsSeconds: 4000.2 },
      { ...fourByFour, repsPerSet: 0 },
      { ...fourByFour, repsPerSet: 2.6 },
      { ...fourByFour, repsPerSet: 40 },
      { ...fourByFour, repsPerSet: Number.NaN },
      { ...limitBouldering, restSeconds: -1 },
    ];
    for (const options of odd) expect(isWorkoutStagePacing(pacingForOptions(options))).toBe(true);
  });

  it('keeps a 4x4’s reps per set whole and between 2 and 10', () => {
    const repsPerSet = (candidate: number) => {
      const pacing = pacingForOptions({ ...fourByFour, repsPerSet: candidate });
      return pacing?.mode === 'afterTick' ? pacing.sets?.repsPerSet : undefined;
    };
    expect(MIN_STAGE_REPS_PER_SET).toBe(2);
    expect(MAX_STAGE_REPS_PER_SET).toBe(10);
    expect(repsPerSet(1)).toBe(MIN_STAGE_REPS_PER_SET);
    expect(repsPerSet(2.6)).toBe(3);
    expect(repsPerSet(40)).toBe(MAX_STAGE_REPS_PER_SET);
    expect(repsPerSet(Number.NaN)).toBe(MIN_STAGE_REPS_PER_SET);
  });
});

describe('stageRestSeconds', () => {
  const fourByFourPacing: WorkoutStagePacing = {
    mode: 'afterTick',
    restSeconds: 30,
    advanceOn: 'set',
    sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
  };

  it('rests between reps, and between sets after a set’s last rep', () => {
    expect(stageRestSeconds(fourByFourPacing, false)).toBe(30);
    expect(stageRestSeconds(fourByFourPacing, true)).toBe(180);
  });

  it('runs no rest between reps for a rest of 0, since that rest never moves the wall', () => {
    expect(stageRestSeconds({ ...fourByFourPacing, restSeconds: 0 }, false)).toBe(0);
    expect(stageRestSeconds({ ...fourByFourPacing, restSeconds: 4 }, false)).toBe(4);
  });

  it('uses the climb rest whatever `closesSet` says on a stage with no sets', () => {
    expect(stageRestSeconds({ mode: 'afterTick', restSeconds: 180, advanceOn: 'send' }, true)).toBe(180);
    expect(stageRestSeconds({ mode: 'afterTick', restSeconds: 180, advanceOn: 'send' }, false)).toBe(180);
  });

  it('never runs a rest that moves the wall under the changeover, a rest of 0 included', () => {
    expect(STAGE_CHANGEOVER_SECONDS).toBe(10);
    expect(stageRestSeconds({ mode: 'afterTick', restSeconds: 0, advanceOn: 'send' }, false)).toBe(
      STAGE_CHANGEOVER_SECONDS,
    );
    expect(stageRestSeconds({ ...fourByFourPacing, sets: { repsPerSet: 4, restBetweenSetsSeconds: 4 } }, true)).toBe(
      STAGE_CHANGEOVER_SECONDS,
    );
    expect(stageRestSeconds({ ...fourByFourPacing, sets: { repsPerSet: 4, restBetweenSetsSeconds: 0 } }, true)).toBe(
      STAGE_CHANGEOVER_SECONDS,
    );
  });

  it('runs an interval as it is, and never under 15 s', () => {
    expect(stageRestSeconds({ mode: 'onTheMinute', restSeconds: 60 }, false)).toBe(60);
    expect(stageRestSeconds({ mode: 'onTheMinute', restSeconds: 60 }, true)).toBe(60);
    expect(stageRestSeconds({ mode: 'onTheMinute', restSeconds: 3 }, false)).toBe(MIN_STAGE_INTERVAL_SECONDS);
  });
});

describe('isWorkoutStagePacing', () => {
  it('accepts every pacing the timed types produce, and a JSON round trip of each', () => {
    for (const options of [onTheMinute, fourByFour, limitBouldering]) {
      const pacing = pacingForOptions(options);
      expect(isWorkoutStagePacing(pacing)).toBe(true);
      expect(isWorkoutStagePacing(JSON.parse(JSON.stringify(pacing)))).toBe(true);
    }
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 60],
    ['an unknown mode', { mode: 'emom', restSeconds: 60 }],
    ['an interval under 15 s', { mode: 'onTheMinute', restSeconds: 10 }],
    ['an interval over an hour', { mode: 'onTheMinute', restSeconds: 3601 }],
    ['fractional seconds', { mode: 'afterTick', restSeconds: 1.5, advanceOn: 'tick' }],
    ['a negative rest', { mode: 'afterTick', restSeconds: -1, advanceOn: 'tick' }],
    ['seconds as a string', { mode: 'afterTick', restSeconds: '60', advanceOn: 'tick' }],
    ['an unknown advance rule', { mode: 'afterTick', restSeconds: 60, advanceOn: 'beat' }],
    ['no advance rule', { mode: 'afterTick', restSeconds: 60 }],
    [
      'a 4x4 from before sets, with its round rest',
      { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 180, advanceOn: 'tick' },
    ],
    ['sets that are not an object', { mode: 'afterTick', restSeconds: 0, advanceOn: 'set', sets: 4 }],
    [
      'one rep a set',
      { mode: 'afterTick', restSeconds: 0, advanceOn: 'set', sets: { repsPerSet: 1, restBetweenSetsSeconds: 180 } },
    ],
    [
      'eleven reps a set',
      { mode: 'afterTick', restSeconds: 0, advanceOn: 'set', sets: { repsPerSet: 11, restBetweenSetsSeconds: 180 } },
    ],
    [
      'a set rest over an hour',
      { mode: 'afterTick', restSeconds: 0, advanceOn: 'set', sets: { repsPerSet: 4, restBetweenSetsSeconds: 3601 } },
    ],
    ['sets with no set rest', { mode: 'afterTick', restSeconds: 0, advanceOn: 'set', sets: { repsPerSet: 4 } }],
    ['the set rule with no sets', { mode: 'afterTick', restSeconds: 0, advanceOn: 'set' }],
    [
      'sets beside the tick rule',
      { mode: 'afterTick', restSeconds: 0, advanceOn: 'tick', sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 } },
    ],
    [
      'sets beside the send rule',
      { mode: 'afterTick', restSeconds: 0, advanceOn: 'send', sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 } },
    ],
  ])('rejects %s', (_label, candidate) => {
    expect(isWorkoutStagePacing(candidate)).toBe(false);
  });

  it('accepts the ends of each range', () => {
    expect(isWorkoutStagePacing({ mode: 'afterTick', restSeconds: 0, advanceOn: 'send' })).toBe(true);
    expect(isWorkoutStagePacing({ mode: 'afterTick', restSeconds: 3600, advanceOn: 'tick' })).toBe(true);
    expect(isWorkoutStagePacing({ mode: 'onTheMinute', restSeconds: 15 })).toBe(true);
    expect(isWorkoutStagePacing({ mode: 'onTheMinute', restSeconds: 3600 })).toBe(true);
    for (const repsPerSet of [2, 10]) {
      for (const restBetweenSetsSeconds of [0, 3600]) {
        expect(
          isWorkoutStagePacing({
            mode: 'afterTick',
            restSeconds: 0,
            advanceOn: 'set',
            sets: { repsPerSet, restBetweenSetsSeconds },
          }),
        ).toBe(true);
      }
    }
  });
});

describe('a 4x4 read by a bundle from before sets', () => {
  /**
   * `isWorkoutStagePacing` as the bundles before sets ship it (the round model,
   * #6727, and the binary's embedded bundle). It knows `tick` and `send` and
   * never looks at `sets`, so a 4x4 stored on `tick` would pass it and move the
   * wall after its first rep.
   */
  function isPacingForABundleBeforeSets(candidate: unknown): boolean {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const pacing = candidate as Record<string, unknown>;
    const isWholeSecondsIn = (seconds: unknown, min: number, max: number) =>
      typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= min && seconds <= max;
    if (pacing.mode === 'onTheMinute') return isWholeSecondsIn(pacing.restSeconds, 15, 3600);
    if (pacing.mode !== 'afterTick') return false;
    return (
      isWholeSecondsIn(pacing.restSeconds, 0, 3600) &&
      (pacing.restBetweenRoundsSeconds === undefined || isWholeSecondsIn(pacing.restBetweenRoundsSeconds, 0, 3600)) &&
      (pacing.advanceOn === 'tick' || pacing.advanceOn === 'send')
    );
  }

  it('loses its pacing there, so the older bundle runs it on the climber’s own rest settings', () => {
    expect(isPacingForABundleBeforeSets(pacingForOptions(fourByFour))).toBe(false);
    expect(isPacingForABundleBeforeSets(JSON.parse(JSON.stringify(pacingForOptions(fourByFour))))).toBe(false);
  });

  it('keeps the pacing of every other timed type readable there', () => {
    expect(isPacingForABundleBeforeSets(pacingForOptions(onTheMinute))).toBe(true);
    expect(isPacingForABundleBeforeSets(pacingForOptions(limitBouldering))).toBe(true);
  });
});
