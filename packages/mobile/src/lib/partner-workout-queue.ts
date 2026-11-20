import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { MAX_SESSION_WORKOUT_ITEMS } from '@boardsesh/workout-summary';
import { appendBlockToRun } from '../components/session-screen/in-session/add-workout-block';

/** Append exactly once, preserving the current climb and counting only items the queue accepted. */
export function appendPartnerWorkout({
  items,
  run,
  existingRun,
  appendQueueItems,
}: {
  items: ClimbQueueItem[];
  run: WorkoutRun;
  existingRun: WorkoutRun | null;
  appendQueueItems: (items: ClimbQueueItem[]) => number;
}) {
  const alreadyRecorded = new Set(existingRun?.stages.flatMap((stage) => stage.itemUuids) ?? []).size;
  const remainingCapacity = Math.max(0, MAX_SESSION_WORKOUT_ITEMS - alreadyRecorded);
  if (items.length > remainingCapacity && run.stages.some((stage) => stage.kind === 'fourByFour'))
    throw new Error('Partner workout exceeds stored plan capacity');
  // Non-round attachments have already committed. Preserve their established
  // partial-add behavior if another local block consumed capacity meanwhile.
  const acceptedItems = items.slice(0, remainingCapacity);
  const landedCount = acceptedItems.length > 0 ? appendQueueItems(acceptedItems) : 0;
  const landedItems = acceptedItems.slice(0, landedCount);
  const landedUuids = landedItems.map((item) => item.uuid);
  const partnerRun = appendBlockToRun(null, run, landedUuids);
  const combinedRun = appendBlockToRun(existingRun, partnerRun, landedUuids);
  return { landedItems, partnerRun, combinedRun };
}
