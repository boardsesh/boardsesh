// What the session screen and the player say about a workout in progress
// (#5379): which stage the current climb is in, how far along, and what is left.
// Pure: the ordering rules live in `locateInRun` (queue order, queued climbs
// only), and everything here is built from it so the card and the player can
// never disagree.

import {
  locateInRun,
  type WorkoutRun,
  type WorkoutRunPosition,
  type WorkoutStageKind,
} from '@boardsesh/playlist-generator';

export type WorkoutStageReadout = {
  id: string;
  kind: WorkoutStageKind;
  /** Climbs from this stage still in the queue. */
  size: number;
  isCurrent: boolean;
  /** Climbs after the current one in this stage. Null on every stage but the current one. */
  remainingAfterCurrent: number | null;
  /**
   * A warm-up planned after the last workout block, stepping back down from
   * it, so it reads "Cool-down" wherever its climbs sit in the queue.
   */
  isCoolDown: boolean;
};

/**
 * Which go on a climb the climber is on, where the stage keeps them on it for
 * more than one (`workoutClimbGo` in workout-runner-readout.ts). `try`: a stage
 * that stays until the climb is sent (limit bouldering), attempts so far plus
 * one. `rep`: a 4x4 set, reps logged so far plus one, never past the set's
 * last.
 */
export type WorkoutClimbGo = { kind: 'try'; number: number } | { kind: 'rep'; number: number; total: number };

export type WorkoutRunReadout = {
  /** Stages with queued climbs, in the order the climber will reach them. */
  stages: WorkoutStageReadout[];
  /** Where the current climb sits. Null when it belongs to no stage. */
  current: WorkoutRunPosition | null;
};

/**
 * The card's view of the run. Null when no stage has a climb left in the queue,
 * so the card disappears once the workout's climbs are all gone.
 */
export function describeWorkoutRun(
  run: WorkoutRun,
  queueUuids: readonly string[],
  currentUuid: string | null,
): WorkoutRunReadout | null {
  const queued = new Set(queueUuids);
  const current = currentUuid === null ? null : locateInRun(run, currentUuid, queueUuids);

  const positioned: Array<{ stageIndex: number; stage: WorkoutStageReadout }> = [];
  for (const runStage of run.stages) {
    const anyQueuedUuid = runStage.itemUuids.find((uuid) => queued.has(uuid));
    if (anyQueuedUuid === undefined) continue;
    // Any queued climb of a stage reports that stage's place and queued size.
    const position = locateInRun(run, anyQueuedUuid, queueUuids);
    if (!position) continue;
    const isCurrent = current?.stageId === runStage.id;
    positioned.push({
      stageIndex: position.stageIndex,
      stage: {
        id: runStage.id,
        kind: runStage.kind,
        size: position.stageSize,
        isCurrent,
        remainingAfterCurrent: isCurrent && current ? current.remainingInStage : null,
        isCoolDown: position.isCoolDown === true,
      },
    });
  }
  if (positioned.length === 0) return null;

  positioned.sort((left, right) => left.stageIndex - right.stageIndex);
  return { stages: positioned.map(({ stage }) => stage), current };
}

/** Minimal translate signature so the label helpers stay out of React. */
export type TranslateWorkoutStage = (key: string, options?: Record<string, string | number>) => string;

/**
 * The stage's name, reusing the workout picker's labels. Literal keys so the
 * i18n analyser sees each one. `isCoolDown` names a warm-up after the last
 * workout block "Cool-down"; it changes no other kind.
 */
export function workoutStageName(kind: WorkoutStageKind, t: TranslateWorkoutStage, isCoolDown = false): string {
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
  }
}

/**
 * "Warm-up · 2 of 5", the player's subtitle part for a workout climb, or
 * "Cool-down · 2 of 5" after the last block. On a 4x4 each climb is a set; with
 * no go to show (`formatWorkoutStagePositionWithGo`) it reads like any stage.
 */
export function formatWorkoutStagePosition(position: WorkoutRunPosition, t: TranslateWorkoutStage): string {
  const stage = workoutStageName(position.kind, t, position.isCoolDown === true);
  return t('mobile.session.workoutStagePosition', {
    stage,
    position: position.positionInStage,
    total: position.stageSize,
  });
}

/**
 * The player's subtitle part with the go the climber is on (`workoutClimbGo`):
 * the try on a stage that stays on a climb until it is sent, "Limit Bouldering
 * · 2 of 3 · Try 3", or the rep and set on a 4x4, "4x4 · Rep 3 of 4 · Set 2 of
 * 4" (reps first, sets second). With no go (every other stage, or the climb is sent) it is
 * `formatWorkoutStagePosition` alone.
 */
export function formatWorkoutStagePositionWithGo(
  position: WorkoutRunPosition,
  go: WorkoutClimbGo | null,
  t: TranslateWorkoutStage,
): string {
  if (go?.kind === 'rep') {
    return t('mobile.session.workoutStageSetPosition', {
      stage: workoutStageName(position.kind, t, position.isCoolDown === true),
      ...repAndSet(position, go),
    });
  }
  const stagePosition = formatWorkoutStagePosition(position, t);
  if (go === null) return stagePosition;
  return t('mobile.workoutRunner.positionWithTry', { position: stagePosition, number: go.number });
}

/** A 4x4 climb's numbers: which rep, and which set (one climb each) it is of. */
function repAndSet(
  position: WorkoutRunPosition,
  go: Extract<WorkoutClimbGo, { kind: 'rep' }>,
): { rep: number; reps: number; set: number; sets: number } {
  return { rep: go.number, reps: go.total, set: position.positionInStage, sets: position.stageSize };
}

/**
 * Where a workout climb sits, as the two pieces the player's top bar lays out:
 * the stage's name, which may be cut, and its numbers, which never are (#6745).
 * "Warm-up" and "2 of 5" ("Cool-down" after the last block), or on a 4x4 "4x4"
 * and "Rep 3 of 4 · Set 2 of 4". A limit climb's try rides with the numbers:
 * "2 of 3 · Try 3". VoiceOver gets the numbers in words, not "·".
 */
export function formatWorkoutStageParts(
  position: WorkoutRunPosition,
  go: WorkoutClimbGo | null,
  t: TranslateWorkoutStage,
): { stage: string; count: string; accessibilityLabel: string } {
  const stage = workoutStageName(position.kind, t, position.isCoolDown === true);
  if (go?.kind === 'rep') {
    const numbers = repAndSet(position, go);
    return {
      stage,
      count: t('mobile.session.workoutStageSetCount', numbers),
      accessibilityLabel: t('mobile.session.workoutStageTopBarSetAria', { stage, ...numbers }),
    };
  }
  const numbers = { position: position.positionInStage, total: position.stageSize };
  // The list's "2 of 5", so a workout and a list read alike.
  const count = t('playView.track.position', numbers);
  const accessibilityLabel = t('mobile.session.workoutStageTopBarAria', { stage, ...numbers });
  if (go === null) return { stage, count, accessibilityLabel };
  return {
    stage,
    count: t('mobile.workoutRunner.positionWithTry', { position: count, number: go.number }),
    accessibilityLabel: t('mobile.session.workoutStageTopBarTryAria', {
      position: accessibilityLabel,
      number: go.number,
    }),
  };
}
