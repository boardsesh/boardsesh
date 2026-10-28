import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

type QueueMirrorSnapshot = {
  queue: readonly ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

/** A queue UUID names an occurrence; a climb UUID alone cannot distinguish repeats. */
export function resolveTickMirror(
  snapshot: QueueMirrorSnapshot,
  climb: Pick<Climb, 'uuid' | 'mirrored'>,
  queueItemUuid?: string,
  matchesActiveBoard = true,
): boolean {
  if (!matchesActiveBoard) return climb.mirrored === true;
  const current = snapshot.currentClimbQueueItem;
  const occurrence =
    queueItemUuid !== undefined
      ? current?.uuid === queueItemUuid
        ? current
        : snapshot.queue.find((item) => item.uuid === queueItemUuid)
      : current;
  return occurrence?.climb.uuid === climb.uuid ? occurrence.climb.mirrored === true : climb.mirrored === true;
}

/** Legacy presence records lack occurrence IDs. Never guess between repeat entries. */
export function unambiguousQueueMirror(
  snapshot: QueueMirrorSnapshot,
  climbUuid: string | undefined,
): boolean | undefined {
  const occurrences = new Map<string, ClimbQueueItem>();
  for (const item of snapshot.queue) {
    if (item.climb.uuid === climbUuid) occurrences.set(item.uuid, item);
  }
  const current = snapshot.currentClimbQueueItem;
  if (current !== null && current.climb.uuid === climbUuid) occurrences.set(current.uuid, current);
  if (occurrences.size !== 1) return undefined;
  return occurrences.values().next().value?.climb.mirrored === true;
}
