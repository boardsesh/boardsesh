import type { ClimbQueue, ClimbQueueItem } from '@boardsesh/queue';
import { isStaleCurrentClimb, type CurrentChangeClock } from '../../lib/ble/stale-current-hold';

/**
 * Issue #7304: walking a list leaves its climbs in the queue, flagged
 * `suggested`, and in now-slot mode a later list tap no longer drops them.
 * Since #6777 Next plays Up next before the list, so a leftover from a list
 * picked days ago (on this board, or on a board the climber has just come back
 * to) beat every climb of the list just picked.
 *
 * Queue entries carry no time, so age is read off the #4979 clock: when the
 * climb on the wall has not changed for 4 h, nothing after it is younger than
 * that. Picking a climb that is not queued yet then drops the `suggested`
 * entries after it. Climbs queued on purpose (Play next, Play last, a workout)
 * are not `suggested` and stay.
 *
 * Solo only: in a crew the queue is the room's, and a local drop would only be
 * resynced back. A step that keeps the queue as Next does (`keepQueue`, #7227)
 * and a move onto an entry already queued (a Next onto Up next) never drop.
 */
export function countStaleUpNextLeftovers({
  inSession,
  keepQueue,
  queue,
  currentClimbQueueItem,
  openedQueueItemUuid,
  clock,
  now,
}: {
  inSession: boolean;
  keepQueue: boolean;
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  openedQueueItemUuid: string;
  clock: CurrentChangeClock | null;
  now: number;
}): number {
  if (inSession || keepQueue || !currentClimbQueueItem) return 0;
  if (!isStaleCurrentClimb(clock, currentClimbQueueItem.uuid, now)) return 0;
  const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  if (currentIndex < 0) return 0;
  if (queue.some(({ uuid }) => uuid === openedQueueItemUuid)) return 0;
  let leftovers = 0;
  for (let index = currentIndex + 1; index < queue.length; index += 1) {
    if (queue[index].suggested === true) leftovers += 1;
  }
  return leftovers;
}
