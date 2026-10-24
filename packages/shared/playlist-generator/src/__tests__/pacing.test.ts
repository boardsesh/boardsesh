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
  MAX_STAGE_REST_SECONDS,
  MIN_STAGE_INTERVAL_SECONDS,
  STAGE_CHANGEOVER_SECONDS,
  TIMED_WORKOUT_TYPES,
  type WorkoutStagePacing,
  isWorkoutStagePacing,
  pacingForOptions,
  roundsForOptions,
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

  it('paces a 4x4 after each tick, with the round rest for a round’s last climb', () => {
    expect(pacingForOptions(fourByFour)).toEqual({
      mode: 'afterTick',
      restSeconds: 0,
      restBetweenRoundsSeconds: 180,
      advanceOn: 'tick',
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
    expect(
      pacingForOptions({ ...fourByFour, restBetweenClimbsSeconds: -4, restBetweenRoundsSeconds: 90.6 }),
    ).toMatchObject({ restSeconds: 0, restBetweenRoundsSeconds: 91 });
    expect(pacingForOptions({ ...limitBouldering, restSeconds: Number.NaN })).toMatchObject({ restSeconds: 0 });

    const odd: GeneratorOptions[] = [
      { ...onTheMinute, intervalSeconds: Number.POSITIVE_INFINITY },
      { ...fourByFour, restBetweenRoundsSeconds: 4000.2 },
      { ...limitBouldering, restSeconds: -1 },
    ];
    for (const options of odd) expect(isWorkoutStagePacing(pacingForOptions(options))).toBe(true);
  });
});

describe('roundsForOptions', () => {
  it('gives a 4x4 its rounds and every other type none', () => {
    expect(roundsForOptions(fourByFour)).toBe(4);
    expect(roundsForOptions(onTheMinute)).toBeUndefined();
    expect(roundsForOptions(limitBouldering)).toBeUndefined();
    for (const options of UNTIMED_OPTIONS) expect(roundsForOptions(options)).toBeUndefined();
  });

  it('keeps the rounds between 1 and 10 and whole', () => {
    expect(roundsForOptions({ ...fourByFour, rounds: 0 })).toBe(1);
    expect(roundsForOptions({ ...fourByFour, rounds: 2.7 })).toBe(2);
    expect(roundsForOptions({ ...fourByFour, rounds: 40 })).toBe(10);
    expect(roundsForOptions({ ...fourByFour, rounds: Number.NaN })).toBe(1);
  });
});

describe('stageRestSeconds', () => {
  const fourByFourPacing: WorkoutStagePacing = {
    mode: 'afterTick',
    restSeconds: 30,
    restBetweenRoundsSeconds: 180,
    advanceOn: 'tick',
  };

  it('rests between climbs, and between rounds after a round’s last climb', () => {
    expect(stageRestSeconds(fourByFourPacing, false)).toBe(30);
    expect(stageRestSeconds(fourByFourPacing, true)).toBe(180);
  });

  it('uses the climb rest at a round’s end when the stage has no round rest', () => {
    expect(stageRestSeconds({ mode: 'afterTick', restSeconds: 180, advanceOn: 'send' }, true)).toBe(180);
  });

  it('never rests less than the changeover, a rest of 0 included', () => {
    expect(STAGE_CHANGEOVER_SECONDS).toBe(10);
    expect(stageRestSeconds({ ...fourByFourPacing, restSeconds: 0 }, false)).toBe(STAGE_CHANGEOVER_SECONDS);
    expect(stageRestSeconds({ ...fourByFourPacing, restBetweenRoundsSeconds: 4 }, true)).toBe(STAGE_CHANGEOVER_SECONDS);
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
    ['a bad round rest', { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 'long', advanceOn: 'tick' }],
  ])('rejects %s', (_label, candidate) => {
    expect(isWorkoutStagePacing(candidate)).toBe(false);
  });

  it('accepts the ends of each range', () => {
    expect(isWorkoutStagePacing({ mode: 'afterTick', restSeconds: 0, advanceOn: 'send' })).toBe(true);
    expect(isWorkoutStagePacing({ mode: 'afterTick', restSeconds: 3600, advanceOn: 'tick' })).toBe(true);
    expect(isWorkoutStagePacing({ mode: 'onTheMinute', restSeconds: 15 })).toBe(true);
    expect(isWorkoutStagePacing({ mode: 'onTheMinute', restSeconds: 3600 })).toBe(true);
  });
});
