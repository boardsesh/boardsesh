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
// Only after a tick (`afterTick`): on the minute the beat is the block's clock.
// Who may tap it at all (the phone that moves the wall) is the card's rule,
// `resolveWorkoutRestCard`; this is the last word at the tap.

import { anchorAfterFire, restAdvanceAllowed, type EffectiveRestPacing } from './rest-timer-pacing';
import { getRestTimerState, noteRestTimerAdvancedFrom, noteRestTimerAutoAdvanceFired } from './rest-timer-store';

export type SkipRestInput = {
  /** The climb the card was shown for. */
  queueItemUuid: string;
  /** The climb on the wall now, read at the tap (`getQueueSnapshot`), not in the render the card came from. */
  wallQueueItemUuid: string | null;
  /** The effective pacing at the tap (`getEffectiveRestPacing`). */
  pacing: Pick<EffectiveRestPacing, 'mode' | 'advanceOn'>;
  nowMs: number;
  /** Moves the wall on (`nextClimb`). Called at most once, and only when the skip was claimed. */
  moveWall: () => void;
};

/** True when the rest was cut short and the wall moved on. */
export function skipRestOnWall({ queueItemUuid, wallQueueItemUuid, pacing, nowMs, moveWall }: SkipRestInput): boolean {
  // The wall moved since the card rendered (a beat, a swipe, a crewmate): the
  // rest the climber meant to skip is gone, and skipping now would skip a climb.
  if (wallQueueItemUuid === null || wallQueueItemUuid !== queueItemUuid) return false;
  if (pacing.mode !== 'afterTick') return false;
  const { armed, crew, cycleId, lastTick, stagePacing, advancedFromQueueItemUuid } = getRestTimerState();
  // A crew clock this app cannot run moves nothing (the scheduler's rule).
  if (!armed || (crew !== null && crew.config === null)) return false;
  // Already moved off this climb on its last tick: a second tap is not a second move.
  if (advancedFromQueueItemUuid === queueItemUuid) return false;
  if (
    !restAdvanceAllowed({
      advanceOn: pacing.advanceOn,
      currentQueueItemUuid: wallQueueItemUuid,
      lastTick,
      stage: stagePacing,
      advancedFromQueueItemUuid,
    })
  ) {
    return false;
  }
  if (!noteRestTimerAutoAdvanceFired(cycleId, pacing.mode, nowMs, nowMs, anchorAfterFire(pacing))) return false;
  noteRestTimerAdvancedFrom(queueItemUuid);
  moveWall();
  return true;
}
