// What the session screens say about a workout (#6903): a block's name, its
// detail line ("V1–V3 · 4 climbs", "4 reps × 4 sets"), its tally ("9 sent · 7
// attempts"), a climb's outcome and the feed card's one-line headline. Pure, so
// the copy is tested without React; every key is a literal so the i18n orphan
// check sees it.

import { isWorkoutStageKind } from '@boardsesh/playlist-generator';
import { formatRestTimerElapsed } from '../../../lib/rest-timer';
import { workoutStageName, type TranslateWorkoutStage } from '../../../lib/workout-run-readout';
import type { WorkoutClimbView, WorkoutHeadlineView, WorkoutStageTally, WorkoutStageView } from './types';

const VISIBLE_SEPARATOR = ' · ';
/** Between the parts of one spoken label: a pause, never "dot". */
const SPOKEN_SEPARATOR = ', ';
const GRADE_SPAN_DASH = '–';
const NO_BREAK_SPACE = '\u00a0';

/** A kind this build knows by name, or "Block" for one a newer app wrote. */
function stageKindName(kind: string, t: TranslateWorkoutStage, isCoolDown: boolean): string {
  return isWorkoutStageKind(kind) ? workoutStageName(kind, t, isCoolDown) : t('mobile.workoutSummary.unknownBlock');
}

/** "4x4 at V4", or the bare name for a warm-up, a cool-down, or a block with no target grade. */
function nameWithGrade(kind: string, grade: string | null | undefined, t: TranslateWorkoutStage, isCoolDown = false) {
  const name = stageKindName(kind, t, isCoolDown);
  if (!grade || kind === 'warmUp') return name;
  return t('mobile.workoutSummary.blockNameAtGrade', { name, grade });
}

export function workoutBlockName(stage: WorkoutStageView, t: TranslateWorkoutStage): string {
  return nameWithGrade(stage.kind, stage.targetGrade, t, stage.isCoolDown);
}

function isFourByFour(stage: WorkoutStageView): stage is WorkoutStageView & { repsPerSet: number } {
  return stage.kind === 'fourByFour' && typeof stage.repsPerSet === 'number' && stage.repsPerSet > 0;
}

/** Sets in a 4x4: the plan's, or one per climb. */
function setCount(stage: WorkoutStageView): number {
  return stage.sets ?? stage.climbs.length;
}

/**
 * The block's grades: "V1–V3" climbing up, "V3–V1" on a cool-down coming down,
 * "V4" when every climb is one grade. Ordered by difficulty when every climb
 * has one; otherwise first climb to last. Null when no climb has a grade.
 */
export function workoutGradeSpan(stage: WorkoutStageView): { from: string; to: string } | null {
  const graded = stage.climbs.filter(
    (climb): climb is WorkoutClimbView & { grade: string } => typeof climb.grade === 'string' && climb.grade !== '',
  );
  const first = graded.at(0);
  const last = graded.at(-1);
  if (!first || !last) return null;

  let low = first;
  let high = last;
  const ranked = graded.every((climb) => typeof climb.difficulty === 'number');
  if (ranked) {
    for (const climb of graded) {
      if ((climb.difficulty ?? 0) < (low.difficulty ?? 0)) low = climb;
      if ((climb.difficulty ?? 0) > (high.difficulty ?? 0)) high = climb;
    }
    if (stage.isCoolDown) return { from: high.grade, to: low.grade };
    return { from: low.grade, to: high.grade };
  }
  return { from: first.grade, to: last.grade };
}

function visibleSpan(span: { from: string; to: string }): string {
  return span.from === span.to ? span.from : `${span.from}${GRADE_SPAN_DASH}${span.to}`;
}

function spokenSpan(span: { from: string; to: string }, t: TranslateWorkoutStage): string {
  return span.from === span.to
    ? span.from
    : t('mobile.session.preWorkoutPreviewGradeSpan', { lowest: span.from, highest: span.to });
}

/** The line under a block's name, and how VoiceOver says it ("by", never "×"). */
export function workoutBlockDetail(
  stage: WorkoutStageView,
  t: TranslateWorkoutStage,
): { text: string; spoken: string } {
  if (isFourByFour(stage)) {
    const sets = setCount(stage);
    return {
      text: t('mobile.session.preGeneratorBlockSummaryRepsBySets', { reps: stage.repsPerSet, count: sets }),
      spoken: t('mobile.workoutSummary.repsBySetsSpoken', { reps: stage.repsPerSet, count: sets }),
    };
  }
  const count = stage.tally.climbs;
  if (stage.kind === 'onTheMinute' && typeof stage.intervalSeconds === 'number' && stage.intervalSeconds > 0) {
    const text = t('mobile.workoutSummary.detailOnTheMinute', {
      count,
      interval: formatRestTimerElapsed(stage.intervalSeconds),
    });
    return { text, spoken: text };
  }
  const span = workoutGradeSpan(stage);
  if (!span) {
    const text = t('mobile.session.workoutStageClimbs', { count });
    return { text, spoken: text };
  }
  return {
    text: t('mobile.workoutSummary.detailSpanClimbs', { span: visibleSpan(span), count }),
    spoken: t('mobile.workoutSummary.detailSpanClimbsSpoken', { span: spokenSpan(span, t), count }),
  };
}

function tallyParts(tally: WorkoutStageTally, t: TranslateWorkoutStage): string[] {
  const parts: string[] = [];
  if (tally.sent > 0) parts.push(t('mobile.workoutRunner.tallySent', { count: tally.sent }));
  if (tally.attempts > 0) parts.push(t('mobile.workoutSummary.tallyAttempts', { count: tally.attempts }));
  if (tally.skipped > 0) parts.push(t('mobile.workoutRunner.tallySkipped', { count: tally.skipped }));
  return parts;
}

/** "9 sent · 7 attempts", leaving out what is zero. Null when nothing was logged or skipped. */
export function workoutTally(
  tally: WorkoutStageTally,
  t: TranslateWorkoutStage,
): { text: string; spoken: string } | null {
  const parts = tallyParts(tally, t);
  if (parts.length === 0) return null;
  // A long tally wraps between its parts, never inside one ("1 / skipped").
  const unbroken = parts.map((part) => part.replace(/ /g, NO_BREAK_SPACE));
  return { text: unbroken.join(VISIBLE_SEPARATOR), spoken: parts.join(SPOKEN_SEPARATOR) };
}

/** A block row's one spoken sentence: name, detail, tally. */
export function workoutBlockAccessibilityLabel(stage: WorkoutStageView, t: TranslateWorkoutStage): string {
  const tally = workoutTally(stage.tally, t);
  return [workoutBlockName(stage, t), workoutBlockDetail(stage, t).spoken, tally?.spoken]
    .filter((part): part is string => !!part)
    .join(SPOKEN_SEPARATOR);
}

export function sentReps(climb: WorkoutClimbView): number {
  return climb.reps.filter((rep) => rep !== 'attempt').length;
}

/** A 4x4 climb's planned reps: the block's, or the ticks logged when more. */
export function plannedReps(climb: WorkoutClimbView, repsPerSet: number | null | undefined): number {
  return Math.max(repsPerSet ?? 0, climb.reps.length);
}

/** Total rep slots and how many were sent, for the 4x4 rep bar. */
export function workoutRepBar(stage: WorkoutStageView): { sent: number; total: number } | null {
  if (!isFourByFour(stage)) return null;
  let total = 0;
  let sent = 0;
  for (const climb of stage.climbs) {
    total += plannedReps(climb, stage.repsPerSet);
    sent += sentReps(climb);
  }
  // A climb the plan has but the derivation left out (hidden from this viewer)
  // still had its reps planned.
  const missingSets = Math.max(0, setCount(stage) - stage.climbs.length);
  total += missingSets * stage.repsPerSet;
  return total > 0 ? { sent, total } : null;
}

export type WorkoutClimbOutcome = 'flash' | 'send' | 'attempt' | 'skipped';

/** What a climb outside a 4x4 came to: its best go, or skipped. */
export function workoutClimbOutcome(climb: WorkoutClimbView): WorkoutClimbOutcome {
  if (climb.skipped || climb.reps.length === 0) return 'skipped';
  if (climb.reps.includes('flash')) return 'flash';
  if (climb.reps.includes('send')) return 'send';
  return 'attempt';
}

/** The words beside a climb: "3 of 4" on a 4x4, else "Flash", "Sent", "2 attempts" or "Skipped". */
export function workoutClimbStatus(
  climb: WorkoutClimbView,
  repsPerSet: number | null | undefined,
  t: TranslateWorkoutStage,
): { text: string; spoken: string } {
  if (typeof repsPerSet === 'number' && repsPerSet > 0) {
    const numbers = { sent: sentReps(climb), total: plannedReps(climb, repsPerSet) };
    return {
      text: t('mobile.workoutSummary.repsSentOfTotal', numbers),
      spoken: t('mobile.workoutSummary.repsSentOfTotalSpoken', numbers),
    };
  }
  const text = climbOutcomeText(workoutClimbOutcome(climb), climb, t);
  return { text, spoken: text };
}

function climbOutcomeText(outcome: WorkoutClimbOutcome, climb: WorkoutClimbView, t: TranslateWorkoutStage): string {
  switch (outcome) {
    case 'flash':
      return t('mobile.workoutSummary.outcomeFlash');
    case 'send':
      return t('mobile.workoutSummary.outcomeSent');
    case 'attempt':
      return t('mobile.workoutSummary.tallyAttempts', { count: climb.reps.length });
    case 'skipped':
      return t('mobile.workoutSummary.outcomeSkipped');
  }
}

/** A climb line's spoken label: name, grade, what it came to. */
export function workoutClimbAccessibilityLabel(
  climb: WorkoutClimbView,
  repsPerSet: number | null | undefined,
  t: TranslateWorkoutStage,
): string {
  return [climb.name ?? t('detail.unknownClimb'), climb.grade, workoutClimbStatus(climb, repsPerSet, t).spoken]
    .filter((part): part is string => !!part)
    .join(SPOKEN_SEPARATOR);
}

/**
 * The feed card's line: "Workout · 4x4 at V4 · 3 blocks", "Workout · 4x4 at V4
 * + Pyramid at V6 · 3 blocks", "Workout · 4x4 at V4 + 2 more · 5 blocks". The
 * block count is left out when it says nothing the names don't.
 */
export function workoutHeadlineText(
  headline: WorkoutHeadlineView,
  t: TranslateWorkoutStage,
): {
  text: string;
  spoken: string;
} {
  const parts = [t('mobile.session.preGeneratorLabel')];
  const main = mainBlocksText(headline, t);
  if (main) parts.push(main);
  const namedBlocks = main ? 1 + Math.min(headline.extraMainBlocks, 1) : 0;
  if (headline.blockCount > namedBlocks || !main) {
    parts.push(t('mobile.workoutSummary.blockCount', { count: headline.blockCount }));
  }
  return { text: parts.join(VISIBLE_SEPARATOR), spoken: parts.join(SPOKEN_SEPARATOR) };
}

function mainBlocksText(headline: WorkoutHeadlineView, t: TranslateWorkoutStage): string | null {
  if (!headline.mainKind) return null;
  const first = nameWithGrade(headline.mainKind, headline.mainTargetGrade, t);
  if (headline.extraMainBlocks <= 0) return first;
  if (headline.extraMainBlocks === 1 && headline.secondKind) {
    const second = nameWithGrade(headline.secondKind, headline.secondTargetGrade, t);
    return t('mobile.workoutSummary.headlineTwoBlocks', { first, second });
  }
  return t('mobile.workoutSummary.headlineMoreBlocks', { first, count: headline.extraMainBlocks });
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
