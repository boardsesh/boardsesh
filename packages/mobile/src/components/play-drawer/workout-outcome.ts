// When the player's small row is one-tap Fell / Sent (#6231, #5380), and what
// a tap logs against. Pure, so the player can decide it without pulling in the
// save path; the taps themselves are `use-workout-one-tap.ts`.
import type { Climb } from '@boardsesh/shared-schema';
import type { WorkoutRun, WorkoutRunStage } from '@boardsesh/playlist-generator';

/**
 * A tap within this long of the wall moving on logs for the climb it left. Long
 * enough for a climber who topped out just before an on-the-minute beat to reach
 * the button, too short for a go on the climb that just lit up. When the climb
 * the wall moved to has no Fell / Sent, the row stays up this long too
 * (`use-workout-outcome-hold.ts`), so the tap still lands on Fell or Sent.
 */
export const WALL_MOVED_GRACE_MS = 2000;

/**
 * Whether a stage gets the Fell / Sent row: it paces the rest timer itself. Keyed
 * on the pacing rather than on the stage kinds, so any timed block gets it,
 * whatever it is called.
 */
export function workoutOutcomeAvailable(stage: Pick<WorkoutRunStage, 'pacing'> | null | undefined): boolean {
  return stage?.pacing !== undefined;
}

/** The run stage a queue item belongs to, if any. */
export function findWorkoutRunStage(run: WorkoutRun | null, queueItemUuid: string | null): WorkoutRunStage | null {
  if (run === null || queueItemUuid === null) return null;
  return run.stages.find((stage) => stage.itemUuids.includes(queueItemUuid)) ?? null;
}

export type WorkoutOutcomeGate = {
  run: WorkoutRun | null;
  /** The queue item the player shows. */
  displayedQueueItemUuid: string | null;
  /** The committed current queue item: the climb on the wall. */
  committedQueueItemUuid: string | null;
  /** Signed in with an account a tick can be logged to. */
  signedIn: boolean;
  /** The climb is on a board the climber isn't at (the switch-board gate is up). */
  boardMismatch: boolean;
  /** A draft: only its setter sees it, and it isn't a workout climb. */
  isDraft: boolean;
};

/**
 * Whether the player shows Fell / Sent: the climb on screen is the one on the
 * wall (not a climb the climber swiped to or a preview), its workout stage paces
 * the rest timer, and the climber can log it here.
 */
export function shouldShowWorkoutOutcome({
  run,
  displayedQueueItemUuid,
  committedQueueItemUuid,
  signedIn,
  boardMismatch,
  isDraft,
}: WorkoutOutcomeGate): boolean {
  if (!signedIn || boardMismatch || isDraft) return false;
  if (displayedQueueItemUuid === null || displayedQueueItemUuid !== committedQueueItemUuid) return false;
  return workoutOutcomeAvailable(findWorkoutRunStage(run, committedQueueItemUuid));
}

/** What a one-tap tick is for: the climb on the wall, on the board it is drawn on. */
export type WorkoutOutcomeTarget = {
  climb: Climb;
  queueItemUuid: string;
  sessionId: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isMirror: boolean;
};
