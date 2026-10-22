// Adding a workout block to a session that is already running (#5379). Pure
// apart from the injected `appendQueueItems`, so the sheet stays thin and the
// rules are tested without React.
//
// The block's climbs go to the END of the queue, the way the playlist "Add to
// queue" row adds them: the append passes no `activateFirstWhenIdle`, so it does
// not move the wall on this phone (and with nothing current, nothing becomes
// current). Known limit, shared with Add to queue: in a crew session with a climb
// on the wall the append writes the whole queue with this phone's current climb,
// so a crew member's wall change that has not reached this phone yet can be
// reverted. Only the climbs that fit under the queue's size cap get a stage; a
// climb whose wire send later fails keeps its stage until the queue resyncs.

import {
  appendStageToRun,
  type GeneratorOptions,
  type WorkoutRun,
  type WorkoutType,
} from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { buildDefaultOptions } from '../pre-session/workout-blocks';

/** The queue's append, as the session's queue provider exposes it. */
export type AppendQueueItems = (items: ClimbQueueItem[]) => number;

export type AddWorkoutBlockResult = {
  /** How many of the block's climbs the queue took. 0 when it was full. */
  landedCount: number;
  /** The session's run with the block's stages added. Null when nothing landed. */
  run: WorkoutRun | null;
  /** The block's stages that got at least one climb. */
  addedStageCount: number;
};

/**
 * Adds a block's stages to the end of the session's run, keeping only the
 * climbs in `landedUuids`. With no run yet, the block's run becomes the
 * session's run, so a session started without the generator turns into a workout.
 */
export function appendBlockToRun(
  existingRun: WorkoutRun | null,
  blockRun: WorkoutRun,
  landedUuids: readonly string[],
): WorkoutRun {
  const landed = new Set(landedUuids);
  let run: WorkoutRun = existingRun ?? { stages: [] };
  for (const stage of blockRun.stages) {
    run = appendStageToRun(
      run,
      stage,
      stage.itemUuids.filter((uuid) => landed.has(uuid)),
    );
  }
  return run;
}

/**
 * Queues a block's climbs behind the live queue and works out the session's
 * new run. The caller stores the run for its session: this never reads or
 * writes the store, so it cannot write one session's run under another's id.
 */
export function addWorkoutBlock({
  items,
  blockRun,
  existingRun,
  appendQueueItems,
}: {
  items: ClimbQueueItem[];
  blockRun: WorkoutRun;
  existingRun: WorkoutRun | null;
  appendQueueItems: AppendQueueItems;
}): AddWorkoutBlockResult {
  if (items.length === 0) return { landedCount: 0, run: null, addedStageCount: 0 };
  // One argument on purpose: no `activateFirstWhenIdle`, so the wall never changes.
  const landedCount = appendQueueItems(items);
  if (landedCount === 0) return { landedCount: 0, run: null, addedStageCount: 0 };

  // The queue keeps each item's uuid and clamps from the end, so the climbs that
  // landed are the first `landedCount` items.
  const landedUuids = items.slice(0, landedCount).map((item) => item.uuid);
  const landed = new Set(landedUuids);
  // Counted from the block, not from what appendStageToRun wrote: the items carry
  // uuids minted for this preview, so none is in the run yet and nothing is skipped.
  const addedStageCount = blockRun.stages.filter((stage) => stage.itemUuids.some((uuid) => landed.has(uuid))).length;
  return { landedCount, run: appendBlockToRun(existingRun, blockRun, landedUuids), addedStageCount };
}

/**
 * The block "Add a block" opens on: the same type and grade as the run's last
 * workout stage, so "one more of those" is a single tap. A run with no graded
 * workout stage (none yet, only a warm-up left, or stored before stages kept
 * their grade) falls back to a volume block at `fallbackGrade`. Never a warm-up:
 * mid-session the climber is already warm.
 */
export function defaultMidSessionBlock(run: WorkoutRun | null, fallbackGrade: number): GeneratorOptions {
  let type: WorkoutType = 'volume';
  let targetGrade = fallbackGrade;
  const stages = run?.stages ?? [];
  for (let position = stages.length - 1; position >= 0; position--) {
    const stage = stages[position];
    if (stage.kind === 'warmUp') continue;
    type = stage.kind;
    targetGrade = stage.targetGrade ?? fallbackGrade;
    break;
  }
  return { ...buildDefaultOptions(type, targetGrade), warmUp: 'none' };
}
