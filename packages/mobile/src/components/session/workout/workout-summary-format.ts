// What the session screens say about a workout (#6903), visible and spoken.
//
// The visible copy is `@boardsesh/workout-summary`'s `format.ts`, the helpers
// web and Strava use too (block name, detail line, tally, climb outcome, feed
// headline), over the shared `session:workout.*` keys. This module adds what
// only the phone needs: the VoiceOver variant of each line ("by", never "×";
// a pause, never "dot") and the summary's totals. Every key is a literal so
// the i18n orphan check sees it.

import {
  isFourByFourStage,
  plannedReps,
  sentReps,
  workoutBlockDetail as sharedBlockDetail,
  workoutBlockName,
  workoutClimbOutcome,
  workoutClimbStatus as sharedClimbStatus,
  workoutGradeSpan,
  workoutHeadlineText as sharedHeadlineText,
  workoutRepBar,
  workoutTallyParts,
  type WorkoutTranslate,
} from '@boardsesh/workout-summary';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type {
  SessionWorkoutView,
  WorkoutClimbView,
  WorkoutHeadlineView,
  WorkoutStageTally,
  WorkoutStageView,
} from './types';

export { plannedReps, sentReps, workoutBlockName, workoutClimbOutcome, workoutGradeSpan, workoutRepBar };

const VISIBLE_SEPARATOR = ' · ';
/** Between the parts of one spoken label: a pause, never "dot". */
const SPOKEN_SEPARATOR = ', ';
/** `workoutGradeSpan` joins a span's ends with it; a grade label never holds one. */
const GRADE_SPAN_DASH = '–';
const NO_BREAK_SPACE = ' ';

/** "V1–V3" said as "V1 to V3". */
function spokenSpan(span: string, t: WorkoutTranslate): string {
  const [lowest, highest] = span.split(GRADE_SPAN_DASH);
  return highest === undefined ? span : t('mobile.session.preWorkoutPreviewGradeSpan', { lowest, highest });
}

/** The line under a block's name, and how VoiceOver says it ("by", never "×"). */
export function workoutBlockDetail(stage: WorkoutStageView, t: WorkoutTranslate): { text: string; spoken: string } {
  const text = sharedBlockDetail(stage, t);
  if (isFourByFourStage(stage)) {
    const sets = stage.sets ?? stage.climbs.length;
    return { text, spoken: t('mobile.workoutSummary.repsBySetsSpoken', { reps: stage.repsPerSet, count: sets }) };
  }
  const isOnTheMinute =
    stage.kind === 'onTheMinute' && typeof stage.intervalSeconds === 'number' && stage.intervalSeconds > 0;
  const span = isOnTheMinute ? null : workoutGradeSpan(stage);
  if (!span) return { text, spoken: text };
  return {
    text,
    spoken: t('mobile.workoutSummary.detailSpanClimbsSpoken', { span: spokenSpan(span, t), count: stage.tally.climbs }),
  };
}

/** "9 sent · 7 attempts", leaving out what is zero. Null when nothing was logged or skipped. */
export function workoutTally(tally: WorkoutStageTally, t: WorkoutTranslate): { text: string; spoken: string } | null {
  const parts = workoutTallyParts(tally, t);
  if (parts.length === 0) return null;
  // A long tally wraps between its parts, never inside one ("1 / skipped").
  const unbroken = parts.map((part) => part.replace(/ /g, NO_BREAK_SPACE));
  return { text: unbroken.join(VISIBLE_SEPARATOR), spoken: parts.join(SPOKEN_SEPARATOR) };
}

/** A block row's one spoken sentence: name, detail, tally. */
export function workoutBlockAccessibilityLabel(stage: WorkoutStageView, t: WorkoutTranslate): string {
  const tally = workoutTally(stage.tally, t);
  return [workoutBlockName(stage, t), workoutBlockDetail(stage, t).spoken, tally?.spoken]
    .filter((part): part is string => !!part)
    .join(SPOKEN_SEPARATOR);
}

/** The words beside a climb: "3 of 4" on a 4x4, else "Flash", "Sent", "2 attempts" or "Skipped". */
export function workoutClimbStatus(
  climb: WorkoutClimbView,
  repsPerSet: number | null | undefined,
  t: WorkoutTranslate,
): { text: string; spoken: string } {
  const text = sharedClimbStatus(climb, repsPerSet, t);
  if (typeof repsPerSet === 'number' && repsPerSet > 0) {
    const numbers = { sent: sentReps(climb), total: plannedReps(climb, repsPerSet) };
    return { text, spoken: t('mobile.workoutSummary.repsSentOfTotalSpoken', numbers) };
  }
  return { text, spoken: text };
}

/** A climb line's spoken label: name, grade, what it came to. */
export function workoutClimbAccessibilityLabel(
  climb: WorkoutClimbView,
  repsPerSet: number | null | undefined,
  t: WorkoutTranslate,
): string {
  return [climb.name ?? t('detail.unknownClimb'), climb.grade, workoutClimbStatus(climb, repsPerSet, t).spoken]
    .filter((part): part is string => !!part)
    .join(SPOKEN_SEPARATOR);
}

/**
 * The feed card's line ("Workout · 4x4 at V4 · 3 blocks") and its spoken form,
 * the same parts with a pause between them.
 */
export function workoutHeadlineText(
  headline: WorkoutHeadlineView,
  t: WorkoutTranslate,
): { text: string; spoken: string } {
  const text = sharedHeadlineText(headline, t);
  return { text, spoken: text.split(VISIBLE_SEPARATOR).join(SPOKEN_SEPARATOR) };
}

/** Sends and attempts across the blocks, for the summary while ticks are still saving. */
export function workoutTotals(stages: readonly WorkoutStageView[]): { sent: number; attempts: number } {
  let sent = 0;
  let attempts = 0;
  for (const stage of stages) {
    sent += stage.tally.sent;
    attempts += stage.tally.attempts;
  }
  return { sent, attempts };
}

/**
 * The summary hero's number on a workout session (#6903). The phone's own
 * count, labelled as this phone's ("15 sends on this phone"), only while it
 * beats the server summary's totals: the server is behind (ticks still saving,
 * or the summary read before they landed), so a server zero never sits beside
 * the phone's blocks. Otherwise the server's numbers and the plain label,
 * whatever the blocks below are drawn from: the server counts every tick of
 * the session, off-plan ones included, which the blocks never do.
 */
export function workoutFeatured(
  summary: Pick<SessionSummary, 'totalSends' | 'totalAttempts'>,
  workout: Pick<SessionWorkoutView, 'stages'>,
  t: WorkoutTranslate,
): { value: number; label: string } {
  const phone = workoutTotals(workout.stages);
  if (phone.sent + phone.attempts > summary.totalSends + summary.totalAttempts) {
    return phone.sent > 0
      ? { value: phone.sent, label: t('summary.featuredPhoneSendsLabel', { count: phone.sent }) }
      : { value: phone.attempts, label: t('summary.featuredPhoneAttemptsLabel', { count: phone.attempts }) };
  }
  return summary.totalSends > 0
    ? { value: summary.totalSends, label: t('summary.featuredSendsLabel', { count: summary.totalSends }) }
    : { value: summary.totalAttempts, label: t('summary.featuredAttemptsLabel', { count: summary.totalAttempts }) };
}
