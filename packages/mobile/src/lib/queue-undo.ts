import type { ClimbQueueItem } from '@boardsesh/queue';

export type QueueContentSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

/**
 * The queue an Undo of a clear or bulk remove should put back.
 *
 * Built from the LIVE queue, not by replaying `before` wholesale, because the
 * queue can be shared: in the seconds between the removal and the Undo a crew
 * member may have added, removed or reordered climbs, and an Undo must only
 * take back what THIS climber removed. So:
 *
 * - every live item stays, in its live order (and its live copy, which may
 *   have been hydrated since);
 * - each removed item goes back right after the item that preceded it before
 *   the removal (the first slot when nothing did);
 * - an item that was neither removed here nor is live any more stays gone —
 *   someone else dropped it;
 * - the current climb is the live one; only when nothing is current does the
 *   pre-removal current come back, and only if it is in the restored queue.
 */
export function restoreRemovedQueueItems(
  before: QueueContentSnapshot,
  removedUuids: ReadonlySet<string>,
  live: QueueContentSnapshot,
): QueueContentSnapshot {
  const restored = [...live.queue];
  let anchorUuid: string | null = null;
  for (const item of before.queue) {
    if (restored.some((restoredItem) => restoredItem.uuid === item.uuid)) {
      anchorUuid = item.uuid;
      continue;
    }
    if (!removedUuids.has(item.uuid)) continue;
    const anchorIndex =
      anchorUuid === null ? -1 : restored.findIndex((restoredItem) => restoredItem.uuid === anchorUuid);
    restored.splice(anchorIndex + 1, 0, item);
    anchorUuid = item.uuid;
  }

  const previousCurrentUuid = before.currentClimbQueueItem?.uuid;
  const currentClimbQueueItem =
    live.currentClimbQueueItem ??
    (previousCurrentUuid === undefined
      ? null
      : (restored.find((restoredItem) => restoredItem.uuid === previousCurrentUuid) ?? null));
  return { queue: restored, currentClimbQueueItem };
}
