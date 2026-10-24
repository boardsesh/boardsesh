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
 * "Cool-down · 2 of 5" after the last block. A climb with a round counts within
 * its round instead: "4x4 · Round 2 of 4 · 3 of 4".
 */
export function formatWorkoutStagePosition(position: WorkoutRunPosition, t: TranslateWorkoutStage): string {
  const stage = workoutStageName(position.kind, t, position.isCoolDown === true);
  if (position.round) {
    return t('mobile.session.workoutStageRoundPosition', {
      stage,
      round: position.round.round,
      rounds: position.round.roundCount,
      position: position.round.positionInRound,
      total: position.round.roundSize,
    });
  }
  return t('mobile.session.workoutStagePosition', {
    stage,
    position: position.positionInStage,
    total: position.stageSize,
  });
}
