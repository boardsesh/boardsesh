// What the player's workout cards say (#6291, #5380, #6231). Pure, so every
// wording rule is tested without a render: the card components only lay it out.
//
// A rest card is what a paced stage's rest looks like over the board, from the
// runner's readout (`describeWorkoutRunner`), the same values the Record tab's
// "Your workout" card shows:
//
//   between two reps of a 4x4 set   "Rest" · "Then rep 2 of 4 · Set 1 of 4"   Go now
//   after a fall on a limit climb   "Rest" · "Then try again · Try 3"         Go now
//   after a 4x4 set's last rep      "Set 2 done" · "Next: Crimp City · V5"    Skip rest
//   at the end of a block           "4x4 done" · "Next: Limit Bouldering"     Skip rest
//   any other paced rest            "Rest" (or "Next climb in") · "Next: …"   Skip rest
//
// A rest that keeps the climb on the wall offers Go now, which only hides the
// card. A rest that moves the wall offers Skip rest, which moves it now, but
// only on an after-tick stage, only on a phone that may move the wall, and only
// where the tap would move it (`restSkipAllowed`, on the pacing the timer
// really runs: a crew clock wins over the stage). On the minute the beat is the
// workout, and a crew phone that does not hold the wall never moves it (it says
// who does instead).

import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutStageKind } from '@boardsesh/playlist-generator';
import type { WorkoutRunnerReadout } from '../../lib/workout-runner-readout';

export type WorkoutRestCardHeading =
  | { kind: 'rest' }
  /** On the minute: the beat comes whether the climber rests or not. */
  | { kind: 'nextBeat' }
  /** The timer is frozen, whatever rest it froze. */
  | { kind: 'paused' }
  /** A 4x4 set's every rep is logged. `set` is its number in the block. */
  | { kind: 'setDone'; set: number }
  /** The rest ends the block: Next lands on another stage. */
  | { kind: 'stageDone'; stage: WorkoutStageKind; isCoolDown: boolean };

export type WorkoutRestCardCaption =
  /** The rest leads back to the same climb for the set's next rep. */
  | { kind: 'nextRep'; rep: number; reps: number; set: number; sets: number }
  /** The rest leads back to the same limit climb for another try. */
  | { kind: 'tryAgain'; tryNumber: number }
  | { kind: 'nextClimb'; item: ClimbQueueItem }
  | { kind: 'nextStage'; stage: WorkoutStageKind; isCoolDown: boolean }
  /** A crew phone that does not hold the wall: another phone moves it on. */
  | { kind: 'movedByHolder' };

/**
 * `skipRest`: end the rest now and move the wall on. `goNow`: the climber goes
 * again before the rest is up; it only hides the card.
 */
export type WorkoutRestCardAction = 'skipRest' | 'goNow';

export type WorkoutRestCardModel = {
  /**
   * This rest: the climb and how many goes are logged on it. A new go is a new
   * rest, so a card hidden with Go now comes back for the next one.
   */
  key: string;
  /** The climb the rest follows, the one on the wall. */
  queueItemUuid: string;
  heading: WorkoutRestCardHeading;
  caption: WorkoutRestCardCaption | null;
  action: WorkoutRestCardAction | null;
};

export type WorkoutRestCardInput = {
  readout: WorkoutRunnerReadout;
  /** What Next lands on (`useWorkoutRunner().nextItem`), the climb the rest moves to. */
  nextItem: ClimbQueueItem | null;
  /**
   * A tap on Skip rest would move the wall now (`restSkipAllowed`): the same
   * check the tap makes, on the effective pacing. False under a crew clock on
   * the minute or one this app cannot run, where the scheduler would not move
   * the wall either.
   */
  skipAllowed: boolean;
};

/** The key a rest card is hidden under: one per climb and go count. */
export function workoutRestCardKey(queueItemUuid: string, attempts: number): string {
  return `${queueItemUuid}:${attempts}`;
}

/**
 * The rest card for the climb on the wall, or null when there is no paced rest
 * to show: the climber is climbing, the workout is done (its own card), the
 * stage keeps the climber's own timer settings, or the timer is off.
 */
export function resolveWorkoutRestCard({
  readout,
  nextItem,
  skipAllowed,
}: WorkoutRestCardInput): WorkoutRestCardModel | null {
  const { phase, rest, current, position, next } = readout;
  if (phase !== 'resting' || rest === null || current === null || position === null) return null;

  const key = workoutRestCardKey(current.queueItemUuid, current.attempts);
  // Next lands on another workout block: this rest ends the current one.
  const nextStage = next?.startsStage && next.kind !== null ? { stageId: next.stageId, kind: next.kind } : null;
  const nextStageIsCoolDown =
    nextStage !== null && readout.stages.some((stage) => stage.id === nextStage.stageId && stage.isCoolDown);

  const heading = ((): WorkoutRestCardHeading => {
    if (rest.paused) return { kind: 'paused' };
    if (rest.staysOnClimb) return { kind: 'rest' };
    if (nextStage !== null) {
      return { kind: 'stageDone', stage: position.kind, isCoolDown: position.isCoolDown === true };
    }
    if (rest.closesSet) return { kind: 'setDone', set: position.positionInStage };
    return rest.mode === 'onTheMinute' ? { kind: 'nextBeat' } : { kind: 'rest' };
  })();

  const caption = ((): WorkoutRestCardCaption | null => {
    if (rest.staysOnClimb) {
      if (rest.nextRep) {
        return {
          kind: 'nextRep',
          rep: rest.nextRep.number,
          reps: rest.nextRep.total,
          set: position.positionInStage,
          sets: position.stageSize,
        };
      }
      return current.go?.kind === 'try' ? { kind: 'tryAgain', tryNumber: current.go.number } : null;
    }
    // The rest moves the wall, but not from here: never promise where it lands.
    if (!rest.drivesWall) return { kind: 'movedByHolder' };
    if (nextStage !== null) return { kind: 'nextStage', stage: nextStage.kind, isCoolDown: nextStageIsCoolDown };
    return nextItem ? { kind: 'nextClimb', item: nextItem } : null;
  })();

  const action = ((): WorkoutRestCardAction | null => {
    if (rest.staysOnClimb) return 'goNow';
    // `advances` already holds the crew rule (`canAdvanceQueue`) and the
    // stage's own. On the minute the beat is the block's clock: no skipping it.
    // `skipAllowed` is the tap's own answer, so the button never does nothing.
    if (!rest.advances || rest.mode !== 'afterTick' || nextItem === null || !skipAllowed) return null;
    return 'skipRest';
  })();

  return { key, queueItemUuid: current.queueItemUuid, heading, caption, action };
}
