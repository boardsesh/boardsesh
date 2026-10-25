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
// in the scheduler, the pill or the sheet. All three are wired: the
// stage input is what `RestTimerPacingSync` resolved for the climb on the wall
// (`resolveStageRestPacing`); the crew input is the session's shared clock this
// phone follows (lib/crew-rest-cadence.ts). See docs/rest-timer.md and
// docs/workout-stages.md ("Pacing").

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

/** A 4x4 set on the wall: the reps logged on its queue item so far, and the reps it takes. */
export type RestTimerSetReps = { logged: number; perSet: number };

/** The pacing of the stage the current climb belongs to, resolved for the timer. */
export type RestTimerStagePacing = {
  sessionId: string;
  stageId: string;
  kind: WorkoutStageKind;
  queueItemUuid: string;
  mode: RestTimerMode;
  /**
   * The rest after the climb's latest tick. Null only between two reps of a
   * 4x4 set with no rest between them: no rest counts down, the climber goes
   * again.
   */
  targetSeconds: number | null;
  advanceOn: RestAdvanceRule;
  /** A 4x4 set's every rep is logged, so this is the set rest and then the wall moves on. */
  closesSet: boolean;
  /** Set on a 4x4 only: the climb stays on the wall until `logged` reaches `perSet`. */
  reps?: RestTimerSetReps;
  /**
   * A warm-up stage queued after the workout: the sheet names it "Cool-down".
   * Display only, so `sameStagePacing` ignores it and it never re-anchors the
   * timer. It cannot flip inside a stage anyway: a stage's id fixes its kind.
   */
  isCoolDown?: true;
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
 * A 4x4 set on the wall with reps still to log: its rests never move the wall.
 * Null, or any other stage, has none left.
 */
export function stageHasRepsLeft(stage: RestTimerStagePacing | null): boolean {
  return stage?.reps !== undefined && stage.reps.logged < stage.reps.perSet;
}

/**
 * Crew beats stage beats settings. A stage auto-advances: a timed block IS a
 * hands-free block, and the climber's own switch is for their own rests. The one
 * exception is a 4x4 set with reps still to log, whose rest never moves the
 * wall: saying so in `autoAdvance` is also what keeps the crew clock (which
 * counts no reps) from firing mid-set, since the crew publisher sends this
 * phone's own pacing. The climber's settings never carry an advance rule, so
 * they run on the deadline exactly as the timer always has.
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
      autoAdvance: !stageHasRepsLeft(stage),
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
 *
 * `stage` is this phone's workout stage pacing (`EffectiveRestPacing.stage`,
 * whichever source won). On a 4x4 the climb moves on only once every rep of
 * the set is logged: a rest between reps runs out and the climb stays up for
 * the next rep. A 4x4 stage resolved for another queue item than the one on
 * the wall (the store catches up one effect after the wall moves) says nothing
 * about this climb's reps, so it moves nothing either.
 *
 * `advancedFromQueueItemUuid` is the climb this timer last moved the wall off
 * (`RestTimerState.advancedFromQueueItemUuid`). The tick that earned that move
 * is spent. When the wall comes back to that climb with no new tick on it (the
 * server's older state restored after a reconnect, and the crew clock's seed
 * bringing back the tick it never saw spent), the same tick must not move the
 * wall again. Found on a 4x4 set that had already moved on (#5380 QA): its
 * reps are all still logged, so nothing else would hold it.
 */
export function restAdvanceAllowed({
  advanceOn,
  currentQueueItemUuid,
  lastTick,
  stage = null,
  advancedFromQueueItemUuid = null,
}: {
  advanceOn: RestAdvanceRule;
  currentQueueItemUuid: string | null;
  lastTick: RestTimerLastTick | null;
  stage?: RestTimerStagePacing | null;
  advancedFromQueueItemUuid?: string | null;
}): boolean {
  if (advanceOn === 'deadline') return true;
  if (lastTick === null || currentQueueItemUuid === null) return false;
  if (lastTick.queueItemUuid !== currentQueueItemUuid) return false;
  if (lastTick.queueItemUuid === advancedFromQueueItemUuid) return false;
  if (stage?.reps !== undefined && (stage.queueItemUuid !== currentQueueItemUuid || stageHasRepsLeft(stage))) {
    return false;
  }
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
 * `repsLogged` is how many ticks this phone logged on the queue item
 * (`countWorkoutRunTicks`); only a 4x4 reads it. Each tick is one rep, a fall
 * included. `reps.logged` stops at the set's size.
 *
 * `targetSeconds` is the rest after the climb's latest tick
 * (`stageRestSeconds`): the changeover for a rest of 0, the interval on the
 * minute, and on a 4x4 the rest between reps until the set's last rep is
 * logged, then the set rest (`closesSet`). A rest of 0 between reps is none
 * at all, so null.
 */
export function resolveStageRestPacing({
  sessionId,
  run,
  position,
  queueItemUuid,
  repsLogged,
}: {
  sessionId: string;
  run: WorkoutRun;
  position: WorkoutRunPosition | null;
  queueItemUuid: string | null;
  repsLogged: number;
}): RestTimerStagePacing | null {
  if (position === null || queueItemUuid === null) return null;
  const stage = run.stages.find((runStage) => runStage.id === position.stageId);
  const stagePacing = stage?.pacing;
  if (!stage || !stagePacing) return null;
  const sets = stagePacing.mode === 'afterTick' ? stagePacing.sets : undefined;
  const closesSet = sets !== undefined && repsLogged >= sets.repsPerSet;
  const restSeconds = stageRestSeconds(stagePacing, closesSet);
  return {
    sessionId,
    stageId: stage.id,
    kind: stage.kind,
    queueItemUuid,
    mode: stagePacing.mode,
    targetSeconds: restSeconds > 0 ? restSeconds : null,
    advanceOn: restAdvanceRuleForStage(stagePacing),
    closesSet,
    // Capped at the set: an extra go during the set rest is no rep of a next
    // set, and the readout never says "4 of 3".
    ...(sets !== undefined
      ? { reps: { logged: Math.min(sets.repsPerSet, Math.max(0, repsLogged)), perSet: sets.repsPerSet } }
      : {}),
    ...(position.isCoolDown === true ? { isCoolDown: true as const } : {}),
    stagePacing,
  };
}

/**
 * The timer's advance rule for a stage. On the minute the beat itself moves the
 * wall: logged or not, the next climb comes up on time. A 4x4 set (`set`) runs
 * on `tick`, the rule a crew clock carries too: what holds it until the set's
 * last rep is its `reps` (`stageHasRepsLeft`), not the rule.
 */
function restAdvanceRuleForStage(stagePacing: WorkoutStagePacing): RestAdvanceRule {
  if (stagePacing.mode === 'onTheMinute') return 'deadline';
  return stagePacing.advanceOn === 'set' ? 'tick' : stagePacing.advanceOn;
}

function sameWorkoutStagePacing(left: WorkoutStagePacing, right: WorkoutStagePacing): boolean {
  if (left.mode === 'onTheMinute' || right.mode === 'onTheMinute') {
    return left.mode === right.mode && left.restSeconds === right.restSeconds;
  }
  return (
    left.restSeconds === right.restSeconds &&
    left.advanceOn === right.advanceOn &&
    left.sets?.repsPerSet === right.sets?.repsPerSet &&
    left.sets?.restBetweenSetsSeconds === right.sets?.restBetweenSetsSeconds
  );
}

/**
 * Field by field, so the sync can write a freshly built object every render and
 * the store still only changes when the pacing does. A 4x4's rep count is
 * pacing too: the rep that closes a set turns the rest into the set rest.
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
    left.closesSet === right.closesSet &&
    left.reps?.logged === right.reps?.logged &&
    left.reps?.perSet === right.reps?.perSet &&
    // `isCoolDown` is display-only and deliberately not compared.
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
 *   none         keep the anchor. A 4x4 rep logged on the climb on the wall is
 *                one of these: the tick already started its rest, and the
 *                count only picks which rest (between reps, or the set rest).
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
