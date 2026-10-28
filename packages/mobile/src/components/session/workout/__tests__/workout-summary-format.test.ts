import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import sessionEnUs from '@boardsesh/i18n/locales/en-US/session.json';
import sessionDe from '@boardsesh/i18n/locales/de/session.json';
import type { WorkoutTranslate } from '@boardsesh/workout-summary';
import {
  workoutBlockAccessibilityLabel,
  workoutBlockDetail,
  workoutBlockName,
  workoutClimbAccessibilityLabel,
  workoutClimbStatus,
  workoutGradeSpan,
  workoutHeadlineText,
  workoutRepBar,
  workoutTally,
  workoutTotals,
  workoutFeatured,
} from '../workout-summary-format';
import {
  COOL_DOWN,
  FOUR_BY_FOUR,
  OTHER_KIND_STAGES,
  STORY_HEADLINE,
  STORY_HEADLINE_MORE,
  STORY_HEADLINE_TWO,
  STORY_WORKOUT,
  WARM_UP,
} from '../workout-story-fixtures';

// The real catalogs through a real i18next instance, so plurals and
// interpolation run exactly as they render in the app.
let t: WorkoutTranslate;
let tDe: WorkoutTranslate;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    ns: ['session'],
    defaultNS: 'session',
    resources: { 'en-US': { session: sessionEnUs }, de: { session: sessionDe } },
    interpolation: { escapeValue: false },
  });
  t = instance.getFixedT('en-US', 'session') as unknown as WorkoutTranslate;
  tDe = instance.getFixedT('de', 'session') as unknown as WorkoutTranslate;
});

const [onTheMinute, pyramid, limit, future] = OTHER_KIND_STAGES;

describe('workoutBlockName', () => {
  it('names a main block with its grade, a warm-up and cool-down bare', () => {
    expect(workoutBlockName(FOUR_BY_FOUR, t)).toBe('4x4 at V4');
    expect(workoutBlockName(WARM_UP, t)).toBe('Warm-up');
    expect(workoutBlockName(COOL_DOWN, t)).toBe('Cool-down');
  });

  it('draws a kind this build does not know as a block', () => {
    expect(workoutBlockName(future!, t)).toBe('Block');
  });
});

describe('workoutBlockDetail', () => {
  it('gives the grade span and climb count, coming down on a cool-down', () => {
    expect(workoutBlockDetail(WARM_UP, t).text).toBe('V1–V3 · 4 climbs');
    expect(workoutBlockDetail(COOL_DOWN, t).text).toBe('V3–V1 · 3 climbs');
    expect(workoutBlockDetail(pyramid!, t).text).toBe('V2–V4 · 5 climbs');
    expect(workoutBlockDetail(limit!, t).text).toBe('V4 · 2 climbs');
  });

  it('gives reps before sets on a 4x4, spelled out for VoiceOver', () => {
    expect(workoutBlockDetail(FOUR_BY_FOUR, t)).toEqual({
      text: '4 reps × 4 sets',
      spoken: '4 reps by 4 sets',
    });
  });

  it('gives the interval on an On the Minute block', () => {
    expect(workoutBlockDetail(onTheMinute!, t).text).toBe('6 climbs, one every 1:00');
  });

  it('says the span in words', () => {
    expect(workoutBlockDetail(WARM_UP, t).spoken).toBe('V1 to V3, 4 climbs');
  });

  it('reads first climb to last when a climb has no difficulty', () => {
    const unranked = { ...WARM_UP, climbs: WARM_UP.climbs.map((climb) => ({ ...climb, difficulty: null })) };
    expect(workoutGradeSpan(unranked)).toBe('V1–V3');
  });
});

/** The visible tally keeps each part on one line with no-break spaces. */
function visible(text: string | undefined): string | undefined {
  return text?.replace(/\u00a0/g, ' ');
}

describe('workoutTally', () => {
  it('counts sends and attempts, leaving out zeros', () => {
    expect(visible(workoutTally(FOUR_BY_FOUR.tally, t)?.text)).toBe('9 sent · 7 attempts');
    expect(visible(workoutTally(WARM_UP.tally, t)?.text)).toBe('4 sent');
    expect(visible(workoutTally(COOL_DOWN.tally, t)?.text)).toBe('2 sent · 1 skipped');
  });

  it('is null when nothing was logged or skipped', () => {
    expect(workoutTally({ sent: 0, attempts: 0, skipped: 0, climbs: 3 }, t)).toBeNull();
  });

  it('uses the singular for one attempt', () => {
    expect(visible(workoutTally({ sent: 0, attempts: 1, skipped: 0, climbs: 1 }, t)?.text)).toBe('1 attempt');
  });

  it('follows the German glossary', () => {
    expect(visible(workoutTally(FOUR_BY_FOUR.tally, tDe)?.text)).toBe('9 Begehungen · 7 Versuche');
  });
});

describe('workoutBlockAccessibilityLabel', () => {
  it('says the whole row as one sentence with no "×" or "·"', () => {
    const label = workoutBlockAccessibilityLabel(FOUR_BY_FOUR, t);
    expect(label).toBe('4x4 at V4, 4 reps by 4 sets, 9 sent, 7 attempts');
    expect(label).not.toMatch(/[×·]/);
  });
});

describe('workoutRepBar', () => {
  it('has one segment per planned rep on a 4x4, and none elsewhere', () => {
    expect(workoutRepBar(FOUR_BY_FOUR)).toEqual({ sent: 9, total: 16 });
    expect(workoutRepBar(WARM_UP)).toBeNull();
  });
});

describe('workoutClimbStatus', () => {
  const [crimpLord] = FOUR_BY_FOUR.climbs;
  it('gives sent reps of the set on a 4x4', () => {
    expect(workoutClimbStatus(crimpLord!, 4, t)).toEqual({ text: '3 of 4', spoken: '3 of 4 reps sent' });
  });

  it('gives the outcome elsewhere', () => {
    expect(workoutClimbStatus(WARM_UP.climbs[0]!, null, t).text).toBe('Flash');
    expect(workoutClimbStatus(WARM_UP.climbs[2]!, null, t).text).toBe('Sent');
    expect(workoutClimbStatus(COOL_DOWN.climbs[2]!, null, t).text).toBe('Skipped');
    expect(workoutClimbStatus(limit!.climbs[0]!, null, t).text).toBe('4 attempts');
  });

  it('labels a climb line for VoiceOver', () => {
    expect(workoutClimbAccessibilityLabel(crimpLord!, 4, t)).toBe('Crimp Lord, V4, 3 of 4 reps sent');
  });
});

describe('workoutHeadlineText', () => {
  it('names the main block and counts every block', () => {
    expect(workoutHeadlineText(STORY_HEADLINE, t)).toEqual({
      text: 'Workout · 4x4 at V4 · 3 blocks',
      spoken: 'Workout, 4x4 at V4, 3 blocks',
    });
  });

  it('names two main blocks, the second by kind alone', () => {
    expect(workoutHeadlineText(STORY_HEADLINE_TWO, t).text).toBe('Workout · 4x4 at V4 + Pyramid');
  });

  it('counts the rest past the first, without a block count', () => {
    expect(workoutHeadlineText(STORY_HEADLINE_MORE, t).text).toBe('Workout · 4x4 at V4 + 2 more');
  });

  it('reads two main blocks with no second kind as one more', () => {
    expect(workoutHeadlineText({ ...STORY_HEADLINE_TWO, secondMainKind: null }, t).text).toBe(
      'Workout · 4x4 at V4 + 1 more',
    );
  });

  it('leaves out a block count the name already says', () => {
    expect(workoutHeadlineText({ ...STORY_HEADLINE, blockCount: 1 }, t).text).toBe('Workout · 4x4 at V4');
  });
});

describe('workoutTotals', () => {
  it('adds the blocks up to the session sends', () => {
    expect(workoutTotals(STORY_WORKOUT.stages)).toEqual({ sent: 15, attempts: 7 });
  });
});

describe('workoutFeatured', () => {
  const serverZero = { totalSends: 0, totalAttempts: 0 };

  it("counts from the phone whenever the phone's workout is drawn, never a server zero beside it", () => {
    expect(workoutFeatured(serverZero, STORY_WORKOUT, 0, true, t)).toEqual({
      value: 15,
      label: 'sends on this phone',
    });
  });

  it('counts attempts from the phone when it sent nothing', () => {
    const attemptsOnly = {
      stages: [{ ...FOUR_BY_FOUR, tally: { sent: 0, attempts: 3, skipped: 0, climbs: 4 } }],
    };
    expect(workoutFeatured(serverZero, attemptsOnly, 0, true, t)).toEqual({
      value: 3,
      label: 'attempts on this phone',
    });
  });

  it("keeps the server's totals for the server's workout", () => {
    expect(workoutFeatured({ totalSends: 15, totalAttempts: 22 }, STORY_WORKOUT, 0, false, t)).toEqual({
      value: 15,
      label: 'sends',
    });
  });

  it('still prefers the phone while its ticks would add to a server copy', () => {
    expect(workoutFeatured({ totalSends: 2, totalAttempts: 2 }, STORY_WORKOUT, 5, false, t).label).toBe(
      'sends on this phone',
    );
  });
});
