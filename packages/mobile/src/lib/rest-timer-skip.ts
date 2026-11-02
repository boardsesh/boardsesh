// Skip rest (#6291): the player's rest card ends a workout rest now and moves
// the wall on, exactly as the rest running out would have.
//
// It is the auto-advance scheduler's own local advance with "now" as the
// deadline: the rule is asked again against the climb on the wall at the tap
// (a tick or send rule needs that climb's tick; a 4x4 set needs every rep), the
// cycle is claimed before the wall moves (so the scheduler's pending timeout,
// on the old cycle, can never move it a second time), and the climb it moved
// off is remembered, so the same tick never moves the wall off it again. The
// claim also tells the crew publisher, which puts the shared clock in step
// (a tick or send rule waits for the next tick, as after a fire).
//
// A paused rest skips too, and the pause goes with it: the timer runs again
// first, then the advance. Without that, a tick or send rule's CLEAR left the
// crew clock paused, and its echo froze the next climb's pill on the old rest's
// seconds until its first log. Resumed first, the next climb starts as after a
// rest that ran out: waiting for its first log, or, under a deadline rule,
// resting from now.
//
// Only after a tick (`afterTick`), on the EFFECTIVE pacing: on the minute the
// beat is the block's clock, and a crew clock wins over the stage, as it does
// for the scheduler. The card asks `restSkipAllowed` with the same pacing before
// it offers the button, so Skip rest never shows where a tap would do nothing.
// Who may tap it at all (the phone that moves the wall) is the card's rule,
// `resolveWorkoutRestCard`; this is the last word at the tap.

import { anchorAfterFire, restAdvanceAllowed, type EffectiveRestPacing } from './rest-timer-pacing';
import {
  getRestTimerState,
  noteRestTimerAdvancedFrom,
  noteRestTimerAutoAdvanceFired,
  resumeRestTimer,
  type RestTimerState,
} from './rest-timer-store';

export type RestSkipQuery = {
  /** The climb the card was shown for. */
  queueItemUuid: string;
  /** The climb on the wall now. At the tap, read then (`getQueueSnapshot`), not in the render the card came from. */
  wallQueueItemUuid: string | null;
  /** The effective pacing (`useEffectiveRestPacing`, `getEffectiveRestPacing` at the tap): the crew clock over the stage. */
  pacing: Pick<EffectiveRestPacing, 'mode' | 'advanceOn'>;
};

/** The rest-timer fields the check reads. `RestTimerState` itself satisfies it. */
export type RestSkipState = Pick<
  RestTimerState,
  'armed' | 'crew' | 'lastTick' | 'stagePacing' | 'advancedFromQueueItemUuid'
>;

export type SkipRestInput = RestSkipQuery & {
  nowMs: number;
  /** Moves the wall on (`nextClimb`). Called at most once, and only when the skip was claimed. */
  moveWall: () => void;
};

/**
 * Whether a tap on Skip rest would move the wall now: everything
 * `skipRestOnWall` checks before it claims the cycle. Pure, so the card can ask
 * it in render with the state it already reads.
 */
export function restSkipAllowed(
  { queueItemUuid, wallQueueItemUuid, pacing }: RestSkipQuery,
  state: RestSkipState,
): boolean {
  // The wall moved since the card rendered (a beat, a swipe, a crewmate): the
  // rest the climber meant to skip is gone, and skipping now would skip a climb.
  if (wallQueueItemUuid === null || wallQueueItemUuid !== queueItemUuid) return false;
  if (pacing.mode !== 'afterTick') return false;
  const { armed, crew, lastTick, stagePacing, advancedFromQueueItemUuid } = state;
  // A crew clock this app cannot run moves nothing (the scheduler's rule).
  if (!armed || (crew !== null && crew.config === null)) return false;
  // Already moved off this climb on its last tick: a second tap is not a second move.
  if (advancedFromQueueItemUuid === queueItemUuid) return false;
  return restAdvanceAllowed({
    advanceOn: pacing.advanceOn,
    currentQueueItemUuid: wallQueueItemUuid,
    lastTick,
    stage: stagePacing,
    advancedFromQueueItemUuid,
  });
}

/** True when the rest was cut short and the wall moved on. */
export function skipRestOnWall({ nowMs, moveWall, ...query }: SkipRestInput): boolean {
  if (!restSkipAllowed(query, getRestTimerState())) return false;
  // Resumed before the claim, so the crew hears RESUME ahead of the fire's own action.
  if (!getRestTimerState().isRunning) resumeRestTimer(nowMs);
  const { cycleId } = getRestTimerState();
  if (!noteRestTimerAutoAdvanceFired(cycleId, query.pacing.mode, nowMs, nowMs, anchorAfterFire(query.pacing))) {
    return false;
  }
  noteRestTimerAdvancedFrom(query.queueItemUuid);
  moveWall();
  return true;
}
