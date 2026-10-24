// The rest timer's EFFECTIVE pacing: the rest length, cadence and auto-advance
// the timer actually runs on right now, and the rule for when a finished rest
// may move the wall. Pure, no React, no I/O (#5396, #5382, #5380).
//
// Three sources can pace the timer, highest priority first:
//   crew      the session's shared clock, set by whoever paces the crew (#5382)
//   stage     the workout stage the current climb belongs to (#5380, #6231)
//   settings  the climber's own preferences in `../settings`
//
// Every reader goes through `resolveEffectiveRestPacing` (via
// `hooks/use-effective-rest-pacing.ts`), so a new source plugs in here and never
// in the scheduler, the pill or the sheet. `settings` and `stage` are wired: the
// stage input is what `RestTimerPacingSync` resolved for the climb on the wall
// (`resolveStageRestPacing`). The crew input stays null until #5382's mobile PR.
// See docs/rest-timer.md and docs/workout-stages.md ("Pacing").

import {
  stageRestSeconds,
  type WorkoutRun,
  type WorkoutRunPosition,
  type WorkoutStageKind,
  type WorkoutStagePacing,
} from '@boardsesh/playlist-generator';
import type { RestTimerMode } from './rest-timer';

/**
 * When a finished rest may move the wall.
 *
 *   deadline  today's behaviour: the deadline itself advances. `afterTick`
 *             re-anchors at the fire, `onTheMinute` keeps beating.
 *   tick      advance only after a tick on the CURRENT queue item; the fire
 *             clears the anchor, so the next rest waits for the next tick.
 *   send      as `tick`, and that tick was a flash or a send (limit bouldering).
 */
export type RestAdvanceRule = 'deadline' | 'tick' | 'send';

export type RestPacingSource = 'settings' | 'stage' | 'crew';

/** The three durable preferences, exactly as `../settings` stores them. */
export type RestPacingSettings = {
  targetSeconds: number | null;
  mode: RestTimerMode;
  autoAdvance: boolean;
};

/** The pacing of the stage the current climb belongs to, resolved for the timer. */
export type RestTimerStagePacing = {
  sessionId: string;
  stageId: string;
  kind: WorkoutStageKind;
  queueItemUuid: string;
  mode: RestTimerMode;
  targetSeconds: number;
  advanceOn: RestAdvanceRule;
  /** The rest after this climb ends a round (4x4), so it is the longer round rest. */
  closesRound: boolean;
  stagePacing: WorkoutStagePacing;
};

/** The crew's shared clock config, as the session wire carries it (#5382). */
export type CrewRestConfig = RestPacingSettings & {
  advanceOn: RestAdvanceRule;
  source: 'settings' | 'stage';
  setByParticipantId: string | null;
};

export type EffectiveRestPacing = RestPacingSettings & {
  advanceOn: RestAdvanceRule;
  source: RestPacingSource;
  /**
   * The local workout stage's pacing whichever source won, so a reader can still
   * say "end of round" under a crew clock. Null when no stage paces this phone.
   */
  stage: RestTimerStagePacing | null;
};

export type EffectiveRestPacingInput = {
  settings: RestPacingSettings;
  stage: RestTimerStagePacing | null;
  crew: CrewRestConfig | null;
};

/**
 * Crew beats stage beats settings. A stage always auto-advances: a timed block
 * IS a hands-free block, and the climber's own switch is for their own rests.
 * The climber's settings never carry an advance rule, so they run on the
 * deadline exactly as the timer always has.
 */
export function resolveEffectiveRestPacing({ settings, stage, crew }: EffectiveRestPacingInput): EffectiveRestPacing {
  if (crew !== null) {
    return {
      targetSeconds: crew.targetSeconds,
      mode: crew.mode,
      autoAdvance: crew.autoAdvance,
      advanceOn: crew.advanceOn,
      source: 'crew',
      stage,
    };
  }
  if (stage !== null) {
    return {
      targetSeconds: stage.targetSeconds,
      mode: stage.mode,
      autoAdvance: true,
      advanceOn: stage.advanceOn,
      source: 'stage',
      stage,
    };
  }
  return {
    targetSeconds: settings.targetSeconds,
    mode: settings.mode,
    autoAdvance: settings.autoAdvance,
    advanceOn: 'deadline',
    source: 'settings',
    stage: null,
  };
}

export type RestTimerTickStatus = 'flash' | 'send' | 'attempt';

/** The last tick the timer saw, and the queue item it was logged against. */
export type RestTimerLastTick = { status: RestTimerTickStatus; queueItemUuid: string | null };

/**
 * Whether a rest that has run out may move the wall. `deadline` always may. The
 * tick rules need a tick logged against the climb that is on the wall NOW: a
 * tick on the previous climb, or one logged from a list with no queue item, is
 * not a reason to light the next one.
 */
export function restAdvanceAllowed({
  advanceOn,
  currentQueueItemUuid,
  lastTick,
}: {
  advanceOn: RestAdvanceRule;
  currentQueueItemUuid: string | null;
  lastTick: RestTimerLastTick | null;
}): boolean {
  if (advanceOn === 'deadline') return true;
  if (lastTick === null || currentQueueItemUuid === null) return false;
  if (lastTick.queueItemUuid !== currentQueueItemUuid) return false;
  if (advanceOn === 'tick') return true;
  return lastTick.status === 'flash' || lastTick.status === 'send';
}

/**
 * What a fired advance does to the anchor. `onTheMinute` keeps its beat whatever
 * the rule. `afterTick` on the deadline starts the next rest at the fire, as
 * today. `afterTick` under a tick rule clears it: the next rest starts at the
 * next tick, so a climber who has not ticked is never walked on.
 */
export function anchorAfterFire({
  mode,
  advanceOn,
}: Pick<EffectiveRestPacing, 'mode' | 'advanceOn'>): 'now' | 'keep' | 'clear' {
  if (mode === 'onTheMinute') return 'keep';
  return advanceOn === 'deadline' ? 'now' : 'clear';
}

/**
 * The pacing of the climb on the wall, when its workout stage paces the timer.
 * `position` is `locateInRun` for that climb, worked out once by the caller.
 * Null when the climb is in no stage, or in a stage that keeps the climber's own
 * settings (warm-up, volume, pyramid, ladder, grade focus).
 *
 * `targetSeconds` is the rest AFTER this climb: a 4x4's round rest when the
 * climb closes its round, the changeover for a rest of 0, the interval on the
 * minute (`stageRestSeconds`).
 */
export function resolveStageRestPacing({
  sessionId,
  run,
  position,
  queueItemUuid,
}: {
  sessionId: string;
  run: WorkoutRun;
  position: WorkoutRunPosition | null;
  queueItemUuid: string | null;
}): RestTimerStagePacing | null {
  if (position === null || queueItemUuid === null) return null;
  const stage = run.stages.find((runStage) => runStage.id === position.stageId);
  const stagePacing = stage?.pacing;
  if (!stage || !stagePacing) return null;
  // Rounds rank by what is still queued, so the last queued climb of a round
  // closes it even after the climber removed one.
  const closesRound = position.round !== undefined && position.round.positionInRound === position.round.roundSize;
  return {
    sessionId,
    stageId: stage.id,
    kind: stage.kind,
    queueItemUuid,
    mode: stagePacing.mode,
    targetSeconds: stageRestSeconds(stagePacing, closesRound),
    // On the minute, the beat itself moves the wall: logged or not, the next
    // climb comes up on time.
    advanceOn: stagePacing.mode === 'onTheMinute' ? 'deadline' : stagePacing.advanceOn,
    closesRound,
    stagePacing,
  };
}

function sameWorkoutStagePacing(left: WorkoutStagePacing, right: WorkoutStagePacing): boolean {
  if (left.mode === 'onTheMinute' || right.mode === 'onTheMinute') {
    return left.mode === right.mode && left.restSeconds === right.restSeconds;
  }
  return (
    left.restSeconds === right.restSeconds &&
    left.restBetweenRoundsSeconds === right.restBetweenRoundsSeconds &&
    left.advanceOn === right.advanceOn
  );
}

/**
 * Field by field, so the sync can write a freshly built object every render and
 * the store still only changes when the pacing does.
 */
export function sameStagePacing(left: RestTimerStagePacing | null, right: RestTimerStagePacing | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.sessionId === right.sessionId &&
    left.stageId === right.stageId &&
    left.kind === right.kind &&
    left.queueItemUuid === right.queueItemUuid &&
    left.mode === right.mode &&
    left.targetSeconds === right.targetSeconds &&
    left.advanceOn === right.advanceOn &&
    left.closesRound === right.closesRound &&
    sameWorkoutStagePacing(left.stagePacing, right.stagePacing)
  );
}

/**
 * What a change of stage pacing does to a running timer's anchor.
 *
 *   anchorNow    the beat starts now: an on-the-minute stage begins, or its
 *                interval changed. Its first climb gets a whole interval instead
 *                of the tail of whatever window was running (or no window at all,
 *                after a rest that waited for a tick).
 *   waitForTick  the rest waits for the next tick: on-the-minute ended (its
 *                anchor means nothing to an after-tick rest), or a new climb of a
 *                tick or send stage is on the wall. That climb's rest starts when
 *                the climber logs it, never from the last climb's tick.
 *   none         keep the anchor.
 *
 * The climber's own settings changing is not a transition: the sheet's controls
 * re-arm the timer themselves.
 */
export type RestTimerPacingTransition = 'none' | 'anchorNow' | 'waitForTick';

export function planRestTimerPacingTransition(
  previous: EffectiveRestPacing,
  next: EffectiveRestPacing,
): RestTimerPacingTransition {
  if (previous.stage === null && next.stage === null) return 'none';
  if (next.mode === 'onTheMinute') {
    return previous.mode === 'onTheMinute' && previous.targetSeconds === next.targetSeconds ? 'none' : 'anchorNow';
  }
  if (previous.mode === 'onTheMinute') return 'waitForTick';
  const newClimbOnTheWall = next.stage !== null && next.stage.queueItemUuid !== previous.stage?.queueItemUuid;
  return newClimbOnTheWall && next.advanceOn !== 'deadline' ? 'waitForTick' : 'none';
}
