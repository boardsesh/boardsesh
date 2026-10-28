import { describe, expect, it } from 'vitest';
import {
  formatWorkoutSeconds,
  workoutBlockDetail,
  workoutBlockName,
  workoutClimbStatus,
  workoutGradeSpan,
  workoutHeadlineOfStages,
  workoutHeadlineText,
  workoutKindName,
  workoutRepBar,
  workoutTally,
  type WorkoutStageLike,
  type WorkoutTranslate,
} from '../index';

// A stand-in for i18next over the en-US session catalog: enough of it for the copy.
const catalog: Record<string, string> = {
  'mobile.session.preGeneratorLabel': 'Workout',
  'mobile.session.preWorkoutSectionWarmUp': 'Warm-up',
  'mobile.session.preWorkoutSectionCoolDown': 'Cool-down',
  'mobile.session.preGeneratorFourByFour': '4x4',
  'mobile.session.preGeneratorPyramid': 'Pyramid',
  'mobile.session.preGeneratorOnTheMinute': 'On the Minute',
  'mobile.session.preGeneratorVolume': 'Volume',
  'mobile.session.preGeneratorBlockSummaryRepsBySets_other': '{{reps}} reps × {{count}} sets',
  'mobile.session.workoutStageClimbs_other': '{{count}} climbs',
  'mobile.workoutRunner.tallySent_other': '{{count}} sent',
  'mobile.workoutRunner.tallySkipped_one': '{{count}} skipped',
  'workout.unknownBlock': 'Block',
  'workout.blockNameAtGrade': '{{name}} at {{grade}}',
  'workout.detailOnTheMinute_other': '{{count}} climbs, one every {{interval}}',
  'workout.detailSpanClimbs_other': '{{span}} · {{count}} climbs',
  'workout.tallyAttempts_one': '{{count}} attempt',
  'workout.tallyAttempts_other': '{{count}} attempts',
  'workout.outcomeFlash': 'Flash',
  'workout.outcomeSent': 'Sent',
  'workout.outcomeSkipped': 'Skipped',
  'workout.repsSentOfTotal': '{{sent}} of {{total}}',
  'workout.blockCount_other': '{{count}} blocks',
  'workout.headlineTwoBlocks': '{{first}} + {{second}}',
  'workout.headlineMoreBlocks_other': '{{first}} + {{count}} more',
};

const t: WorkoutTranslate = (key, options) => {
  const count = options?.count;
  const plural = typeof count === 'number' ? catalog[`${key}_${count === 1 ? 'one' : 'other'}`] : undefined;
  const template = plural ?? catalog[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name]));
};

const tally = (sent: number, attempts: number, skipped: number, climbs: number) => ({
  sent,
  attempts,
  skipped,
  climbs,
});

const fourByFour: WorkoutStageLike = {
  kind: 'fourByFour',
  isCoolDown: false,
  targetGrade: 'V4',
  repsPerSet: 4,
  sets: 4,
  climbs: [
    { reps: ['flash', 'send', 'send', 'attempt'], skipped: false },
    { reps: ['send', 'send', 'attempt', 'attempt'], skipped: false },
    { reps: ['send', 'attempt', 'attempt', 'send'], skipped: false },
    { reps: ['attempt', 'send', 'send', 'attempt'], skipped: false },
  ],
  tally: tally(9, 7, 0, 4),
};

describe('workout block copy', () => {
  it('names blocks with their grade, warm-ups and unknown kinds bare', () => {
    expect(workoutBlockName(fourByFour, t)).toBe('4x4 at V4');
    expect(workoutBlockName({ kind: 'warmUp', isCoolDown: false, targetGrade: 'V3' }, t)).toBe('Warm-up');
    expect(workoutBlockName({ kind: 'warmUp', isCoolDown: true }, t)).toBe('Cool-down');
    expect(workoutKindName('somethingNew', t)).toBe('Block');
  });

  it('describes a 4x4 in reps before sets, others by span or interval', () => {
    expect(workoutBlockDetail(fourByFour, t)).toBe('4 reps × 4 sets');
    const pyramid: WorkoutStageLike = {
      kind: 'pyramid',
      isCoolDown: false,
      climbs: [
        { reps: ['send'], skipped: false, grade: 'V1', difficulty: 14 },
        { reps: ['send'], skipped: false, grade: 'V3', difficulty: 16 },
        { reps: [], skipped: true, grade: 'V2', difficulty: 15 },
      ],
      tally: tally(2, 0, 1, 3),
    };
    expect(workoutBlockDetail(pyramid, t)).toBe('V1–V3 · 3 climbs');
    expect(workoutGradeSpan({ ...pyramid, isCoolDown: true })).toBe('V3–V1');
    expect(
      workoutBlockDetail(
        { kind: 'onTheMinute', isCoolDown: false, intervalSeconds: 60, climbs: [], tally: tally(0, 0, 6, 6) },
        t,
      ),
    ).toBe('6 climbs, one every 1:00');
    expect(workoutBlockDetail({ kind: 'volume', isCoolDown: false, climbs: [], tally: tally(0, 0, 2, 2) }, t)).toBe(
      '2 climbs',
    );
  });

  it('tallies in ticks, leaving out zeros', () => {
    expect(workoutTally(tally(9, 7, 0, 4), t)).toBe('9 sent · 7 attempts');
    expect(workoutTally(tally(0, 1, 1, 2), t)).toBe('1 attempt · 1 skipped');
    expect(workoutTally(tally(0, 0, 0, 0), t)).toBeNull();
  });

  it('counts a 4x4 rep bar, planning reps for sets the viewer cannot see', () => {
    expect(workoutRepBar(fourByFour)).toEqual({ sent: 9, total: 16 });
    expect(workoutRepBar({ ...fourByFour, sets: 5 })).toEqual({ sent: 9, total: 20 });
    expect(workoutRepBar({ ...fourByFour, kind: 'pyramid' })).toBeNull();
  });

  it('says what a climb came to: reps on a 4x4, else its best go', () => {
    expect(workoutClimbStatus(fourByFour.climbs[0], 4, t)).toBe('3 of 4');
    expect(workoutClimbStatus({ reps: ['attempt', 'flash'], skipped: false }, null, t)).toBe('Flash');
    expect(workoutClimbStatus({ reps: ['attempt', 'send'], skipped: false }, null, t)).toBe('Sent');
    expect(workoutClimbStatus({ reps: ['attempt', 'attempt'], skipped: false }, null, t)).toBe('2 attempts');
    expect(workoutClimbStatus({ reps: [], skipped: true }, null, t)).toBe('Skipped');
  });

  it('formats intervals like the rest timer', () => {
    expect(formatWorkoutSeconds(60)).toBe('1:00');
    expect(formatWorkoutSeconds(45)).toBe('0:45');
  });
});

describe('workout headline', () => {
  const warmUp = { kind: 'warmUp', targetGrade: 'V3' };
  const coolDown = { kind: 'warmUp', targetGrade: null };

  it('reads "Workout · 4x4 at V4 · 3 blocks" for one main block', () => {
    const headline = workoutHeadlineOfStages([warmUp, { kind: 'fourByFour', targetGrade: 'V4' }, coolDown]);
    expect(headline).toEqual({
      mainKind: 'fourByFour',
      mainTargetGrade: 'V4',
      secondMainKind: null,
      blockCount: 3,
      extraMainBlocks: 0,
    });
    expect(workoutHeadlineText(headline, t)).toBe('Workout · 4x4 at V4 · 3 blocks');
  });

  it('reads "A + B" for two main blocks and "A + N more" past that', () => {
    const two = workoutHeadlineOfStages([{ kind: 'fourByFour', targetGrade: 'V4' }, { kind: 'pyramid' }]);
    expect(workoutHeadlineText(two, t)).toBe('Workout · 4x4 at V4 + Pyramid');
    const three = workoutHeadlineOfStages([
      { kind: 'fourByFour', targetGrade: 'V4' },
      { kind: 'pyramid' },
      { kind: 'volume' },
    ]);
    expect(workoutHeadlineText(three, t)).toBe('Workout · 4x4 at V4 + 2 more');
  });

  it('counts blocks when there is no main block', () => {
    expect(workoutHeadlineText({ mainKind: null, blockCount: 2, extraMainBlocks: 0 }, t)).toBe('Workout · 2 blocks');
  });
});
