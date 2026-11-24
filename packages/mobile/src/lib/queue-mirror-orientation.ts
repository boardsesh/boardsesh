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

/** Index the immutable queue once per change; repeated occurrences have no unique orientation. */
export function createQueueMirrorReader(getSnapshot: () => QueueMirrorSnapshot) {
  let previousSnapshot: QueueMirrorSnapshot | undefined;
  const mirrorByClimb = new Map<string, boolean | undefined>();
  return (climbUuid: string) => {
    const snapshot = getSnapshot();
    if (
      previousSnapshot?.queue !== snapshot.queue ||
      previousSnapshot.currentClimbQueueItem !== snapshot.currentClimbQueueItem
    ) {
      const occurrences = new Map(snapshot.queue.map((item) => [item.uuid, item]));
      const current = snapshot.currentClimbQueueItem;
      if (current) occurrences.set(current.uuid, current);
      mirrorByClimb.clear();
      for (const { climb } of occurrences.values()) {
        mirrorByClimb.set(climb.uuid, mirrorByClimb.has(climb.uuid) ? undefined : climb.mirrored === true);
      }
      previousSnapshot = snapshot;
    }
    return mirrorByClimb.get(climbUuid);
  };
}
