// What a session screen says about a workout (#6903): a block's name ("4x4 at
// V4"), its detail line ("V1–V3 · 4 climbs", "4 reps × 4 sets"), its tally ("9
// sent · 7 attempts"), a climb's outcome ("3 of 4", "Flash", "Skipped") and the
// one-line headline ("Workout · 4x4 at V4 · 3 blocks"). Pure and renderer
// agnostic: the caller hands in its i18next `t` bound to the `session`
// namespace. Every key is a literal so the orphan check sees it.
//
// The wording follows the mobile session summary (#6965). Mobile still carries
// its own copy of these helpers under `mobile.workoutSummary.*`; it can switch to
// this module and drop the duplicates.

import { mainWorkoutStages } from './derive';
import type { DerivedWorkoutTally, SessionWorkoutRepOutcome } from './types';

/** i18next's `t`, bound to the `session` namespace. */
export type WorkoutTranslate = (key: string, options?: Record<string, unknown>) => string;

/** A climb of a block as a screen holds it: the server's `SessionWorkoutClimb`, outcomes lowercased. */
export type WorkoutClimbLike = {
  reps: ReadonlyArray<SessionWorkoutRepOutcome>;
  skipped: boolean;
  /** Display grade label, already in the viewer's grade system. */
  grade?: string | null;
  /** Difficulty id, for ordering the block's grade span. Unknown: first climb to last. */
  difficulty?: number | null;
};

/** A block as a screen holds it: the server's `SessionWorkoutStage`, grades as display labels. */
export type WorkoutStageLike = {
  kind: string;
  isCoolDown: boolean;
  targetGrade?: string | null;
  repsPerSet?: number | null;
  sets?: number | null;
  intervalSeconds?: number | null;
  climbs: ReadonlyArray<WorkoutClimbLike>;
  tally: DerivedWorkoutTally;
};

/** A feed card's line, from `workoutHeadline` or the server's `SessionWorkoutHeadline`. */
export type WorkoutHeadlineLike = {
  mainKind?: string | null;
  mainTargetGrade?: string | null;
  secondMainKind?: string | null;
  blockCount: number;
  extraMainBlocks: number;
};

const SEPARATOR = ' · ';
const GRADE_SPAN_DASH = '–';

/** A kind's name. A kind newer than this build reads "Block". */
export function workoutKindName(kind: string, t: WorkoutTranslate, isCoolDown = false): string {
  switch (kind) {
    case 'warmUp':
      return isCoolDown ? t('mobile.session.preWorkoutSectionCoolDown') : t('mobile.session.preWorkoutSectionWarmUp');
    case 'volume':
      return t('mobile.session.preGeneratorVolume');
    case 'pyramid':
      return t('mobile.session.preGeneratorPyramid');
    case 'ladder':
      return t('mobile.session.preGeneratorLadder');
    case 'gradeFocus':
      return t('mobile.session.preGeneratorGradeFocus');
    case 'onTheMinute':
      return t('mobile.session.preGeneratorOnTheMinute');
    case 'fourByFour':
      return t('mobile.session.preGeneratorFourByFour');
    case 'limitBouldering':
      return t('mobile.session.preGeneratorLimitBouldering');
    default:
      return t('workout.unknownBlock');
  }
}

function nameWithGrade(kind: string, grade: string | null | undefined, t: WorkoutTranslate, isCoolDown = false) {
  const name = workoutKindName(kind, t, isCoolDown);
  if (!grade || kind === 'warmUp') return name;
  return t('workout.blockNameAtGrade', { name, grade });
}

/** "4x4 at V4"; the bare name for a warm-up, a cool-down, or a block with no target grade. */
export function workoutBlockName(
  stage: Pick<WorkoutStageLike, 'kind' | 'isCoolDown' | 'targetGrade'>,
  t: WorkoutTranslate,
) {
  return nameWithGrade(stage.kind, stage.targetGrade, t, stage.isCoolDown);
}

/** A 4x4 with its reps per set known: drawn one row per set, counted in reps. */
export function isFourByFourStage<Stage extends Pick<WorkoutStageLike, 'kind' | 'repsPerSet'>>(
  stage: Stage,
): stage is Stage & { repsPerSet: number } {
  return stage.kind === 'fourByFour' && typeof stage.repsPerSet === 'number' && stage.repsPerSet > 0;
}

/** "1:00", "0:45": an interval as the rest timer shows it. */
export function formatWorkoutSeconds(totalSeconds: number): string {
  const whole = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The block's grades: "V1–V3" climbing up, "V3–V1" on a cool-down coming down,
 * "V4" when every climb is one grade. Ordered by difficulty when every graded
 * climb has one; otherwise first climb to last. Null when no climb has a grade.
 */
export function workoutGradeSpan(stage: Pick<WorkoutStageLike, 'isCoolDown' | 'climbs'>): string | null {
  const graded = stage.climbs.filter(
    (climb): climb is WorkoutClimbLike & { grade: string } => typeof climb.grade === 'string' && climb.grade !== '',
  );
  const first = graded.at(0);
  const last = graded.at(-1);
  if (!first || !last) return null;
  let low = first;
  let high = last;
  if (graded.every((climb) => typeof climb.difficulty === 'number')) {
    for (const climb of graded) {
      if ((climb.difficulty ?? 0) < (low.difficulty ?? 0)) low = climb;
      if ((climb.difficulty ?? 0) > (high.difficulty ?? 0)) high = climb;
    }
    [low, high] = stage.isCoolDown ? [high, low] : [low, high];
  }
  return low.grade === high.grade ? low.grade : `${low.grade}${GRADE_SPAN_DASH}${high.grade}`;
}

/** The line under a block's name: "4 reps × 4 sets", "6 climbs, one every 1:00", "V1–V3 · 4 climbs". */
export function workoutBlockDetail(stage: WorkoutStageLike, t: WorkoutTranslate): string {
  if (isFourByFourStage(stage)) {
    return t('mobile.session.preGeneratorBlockSummaryRepsBySets', {
      reps: stage.repsPerSet,
      count: stage.sets ?? stage.climbs.length,
    });
  }
  const count = stage.tally.climbs;
  if (stage.kind === 'onTheMinute' && typeof stage.intervalSeconds === 'number' && stage.intervalSeconds > 0) {
    return t('workout.detailOnTheMinute', { count, interval: formatWorkoutSeconds(stage.intervalSeconds) });
  }
  const span = workoutGradeSpan(stage);
  if (!span) return t('mobile.session.workoutStageClimbs', { count });
  return t('workout.detailSpanClimbs', { span, count });
}

/** "9 sent", "7 attempts", "1 skipped", leaving out what is zero. */
export function workoutTallyParts(tally: DerivedWorkoutTally, t: WorkoutTranslate): string[] {
  const parts: string[] = [];
  if (tally.sent > 0) parts.push(t('mobile.workoutRunner.tallySent', { count: tally.sent }));
  if (tally.attempts > 0) parts.push(t('workout.tallyAttempts', { count: tally.attempts }));
  if (tally.skipped > 0) parts.push(t('mobile.workoutRunner.tallySkipped', { count: tally.skipped }));
  return parts;
}

/** "9 sent · 7 attempts". Null when nothing was logged or skipped. */
export function workoutTally(tally: DerivedWorkoutTally, t: WorkoutTranslate): string | null {
  const parts = workoutTallyParts(tally, t);
  return parts.length === 0 ? null : parts.join(SEPARATOR);
}

/** Flash and send reps on a climb. */
export function sentReps(climb: Pick<WorkoutClimbLike, 'reps'>): number {
  return climb.reps.filter((rep) => rep !== 'attempt').length;
}

/** A 4x4 climb's planned reps: the block's, or the ticks logged when more. */
export function plannedReps(climb: Pick<WorkoutClimbLike, 'reps'>, repsPerSet: number | null | undefined): number {
  return Math.max(repsPerSet ?? 0, climb.reps.length);
}

/**
 * A 4x4's reps sent of reps planned, for its rep bar and the Strava line. A set
 * the viewer can't see (left out by the server) still had its reps planned.
 * Null for any other block.
 */
export function workoutRepBar(stage: WorkoutStageLike): { sent: number; total: number } | null {
  if (!isFourByFourStage(stage)) return null;
  let total = 0;
  let sent = 0;
  for (const climb of stage.climbs) {
    total += plannedReps(climb, stage.repsPerSet);
    sent += sentReps(climb);
  }
  total += Math.max(0, (stage.sets ?? stage.climbs.length) - stage.climbs.length) * stage.repsPerSet;
  return total > 0 ? { sent, total } : null;
}

export type WorkoutClimbOutcome = 'flash' | 'send' | 'attempt' | 'skipped';

/** What a climb outside a 4x4 came to: its best go, or skipped. */
export function workoutClimbOutcome(climb: Pick<WorkoutClimbLike, 'reps' | 'skipped'>): WorkoutClimbOutcome {
  if (climb.skipped || climb.reps.length === 0) return 'skipped';
  if (climb.reps.includes('flash')) return 'flash';
  if (climb.reps.includes('send')) return 'send';
  return 'attempt';
}

/** The words beside a climb: "3 of 4" on a 4x4, else "Flash", "Sent", "2 attempts" or "Skipped". */
export function workoutClimbStatus(
  climb: Pick<WorkoutClimbLike, 'reps' | 'skipped'>,
  repsPerSet: number | null | undefined,
  t: WorkoutTranslate,
): string {
  if (typeof repsPerSet === 'number' && repsPerSet > 0) {
    return t('workout.repsSentOfTotal', { sent: sentReps(climb), total: plannedReps(climb, repsPerSet) });
  }
  switch (workoutClimbOutcome(climb)) {
    case 'flash':
      return t('workout.outcomeFlash');
    case 'send':
      return t('workout.outcomeSent');
    case 'attempt':
      return t('workout.tallyAttempts', { count: climb.reps.length });
    case 'skipped':
      return t('workout.outcomeSkipped');
  }
}

/** The headline of stages a screen already holds, grades as display labels. */
export function workoutHeadlineOfStages(
  stages: ReadonlyArray<Pick<WorkoutStageLike, 'kind' | 'targetGrade'>>,
): WorkoutHeadlineLike {
  const [first, second, ...rest] = mainWorkoutStages(stages);
  return {
    mainKind: first?.kind ?? null,
    mainTargetGrade: first?.targetGrade ?? null,
    secondMainKind: second?.kind ?? null,
    blockCount: stages.length,
    extraMainBlocks: (second ? 1 : 0) + rest.length,
  };
}

/** "4x4 at V4", "4x4 at V4 + Pyramid", "4x4 at V4 + 2 more". Null with no main block. */
export function workoutMainBlocksText(headline: WorkoutHeadlineLike, t: WorkoutTranslate): string | null {
  if (!headline.mainKind) return null;
  const first = nameWithGrade(headline.mainKind, headline.mainTargetGrade, t);
  if (headline.extraMainBlocks <= 0) return first;
  if (headline.extraMainBlocks === 1 && headline.secondMainKind) {
    return t('workout.headlineTwoBlocks', { first, second: workoutKindName(headline.secondMainKind, t) });
  }
  return t('workout.headlineMoreBlocks', { first, count: headline.extraMainBlocks });
}

/**
 * The feed card's line: "Workout · 4x4 at V4 · 3 blocks" for one main block,
 * "Workout · 4x4 at V4 + Pyramid" for two, "Workout · 4x4 at V4 + 2 more" past
 * that. The block count rides only with a single main block, where it adds the
 * warm-up and cool-down the name leaves out.
 */
export function workoutHeadlineText(headline: WorkoutHeadlineLike, t: WorkoutTranslate): string {
  const parts = [t('mobile.session.preGeneratorLabel')];
  const main = workoutMainBlocksText(headline, t);
  if (main) parts.push(main);
  const singleMain = main !== null && headline.extraMainBlocks <= 0;
  if (main === null || (singleMain && headline.blockCount > 1)) {
    parts.push(t('workout.blockCount', { count: headline.blockCount }));
  }
  return parts.join(SEPARATOR);
}
