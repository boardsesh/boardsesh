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
// in the scheduler, the pill or the sheet. Today only `settings` is wired; the
// stage and crew inputs are always null until their PRs land. See
// docs/rest-timer.md.

import type { WorkoutStageKind } from '@boardsesh/playlist-generator';
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

/**
 * A workout stage's own pacing, as the shared playlist generator derives it from
 * the block options (contracts §1). Mirrors `WorkoutStagePacing` in
 * `@boardsesh/playlist-generator`'s pacing module, which lands in a parallel PR;
 * the pacing PR swaps this for that import. The two are structurally identical,
 * so nothing typed against either breaks on the swap.
 */
export type WorkoutStagePacing =
  | { mode: 'onTheMinute'; restSeconds: number }
  | {
      mode: 'afterTick';
      restSeconds: number;
      restBetweenRoundsSeconds?: number;
      advanceOn: 'tick' | 'send';
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
