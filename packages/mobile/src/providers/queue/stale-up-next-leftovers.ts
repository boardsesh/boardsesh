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
 * that. A pick (a uuid the queue doesn't hold yet, even when placement then
 * resolves it onto a History copy of the same climb) drops the `suggested`
 * entries after the new Now. Play next and Play last climbs are not
 * `suggested` and stay. A workout's climbs are, so they stay only while their
 * workout runs (`liveWorkoutQueueItemUuids`): once its session ends they age
 * out like any leftover.
 *
 * Solo only: in a crew the queue is the room's, and a local drop would only be
 * resynced back. A step that keeps the queue as Next does (`keepQueue`, #7227)
 * and a step onto an entry already queued (Next, a queue row) never drop, and
 * they restart the clock: a climber who swipes onto a leftover first keeps the
 * leftovers.
 *
 * Returns the queue-item uuids to drop, in queue order; empty for none.
 */
export function findStaleUpNextLeftovers({
  inSession,
  keepQueue,
  queue,
  currentClimbQueueItem,
  openedQueueItemUuid,
  liveWorkoutQueueItemUuids,
  clock,
  now,
}: {
  inSession: boolean;
  keepQueue: boolean;
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  openedQueueItemUuid: string;
  /** The queue items of the workout still running on this phone. */
  liveWorkoutQueueItemUuids: ReadonlySet<string>;
  clock: CurrentChangeClock | null;
  now: number;
}): string[] {
  if (inSession || keepQueue || !currentClimbQueueItem) return [];
  if (!isStaleCurrentClimb(clock, currentClimbQueueItem.uuid, now)) return [];
  const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  if (currentIndex < 0) return [];
  if (queue.some(({ uuid }) => uuid === openedQueueItemUuid)) return [];
  const leftovers: string[] = [];
  for (let index = currentIndex + 1; index < queue.length; index += 1) {
    const { uuid, suggested } = queue[index];
    if (suggested === true && !liveWorkoutQueueItemUuids.has(uuid)) leftovers.push(uuid);
  }
  return leftovers;
}
