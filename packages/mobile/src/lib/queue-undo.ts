import { MAX_SYNCED_QUEUE_ITEMS, type ClimbQueueItem } from '@boardsesh/queue';

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
 * - the current climb is the live one. Only when nothing is current, AND the
 *   pre-removal current is one of the climbs this climber removed, does it come
 *   back: a null current with that climb never removed here means a crew
 *   member unset it, and the Undo must not override them;
 * - the result never exceeds `cap` (the party backend's `setQueue` limit, which
 *   throws rather than truncating). Live items always stay; re-added items are
 *   dropped from the end until it fits, and `droppedCount` says how many.
 */
export function restoreRemovedQueueItems(
  before: QueueContentSnapshot,
  removedUuids: ReadonlySet<string>,
  live: QueueContentSnapshot,
  cap: number = MAX_SYNCED_QUEUE_ITEMS,
): QueueContentSnapshot & { droppedCount: number } {
  const restored = [...live.queue];
  const readded = new Set<string>();
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
    readded.add(item.uuid);
    anchorUuid = item.uuid;
  }

  let droppedCount = 0;
  for (let index = restored.length - 1; index >= 0 && restored.length > cap; index -= 1) {
    if (!readded.has(restored[index].uuid)) continue;
    readded.delete(restored[index].uuid);
    restored.splice(index, 1);
    droppedCount += 1;
  }

  const previousCurrentUuid = before.currentClimbQueueItem?.uuid;
  const currentClimbQueueItem =
    live.currentClimbQueueItem ??
    (previousCurrentUuid !== undefined && readded.has(previousCurrentUuid)
      ? (restored.find((restoredItem) => restoredItem.uuid === previousCurrentUuid) ?? null)
      : null);
  return { queue: restored, currentClimbQueueItem, droppedCount };
}
