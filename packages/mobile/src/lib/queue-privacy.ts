import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

/** A saved reference is not authorization to keep displaying a copied climb. */
export function sanitizeQueueClimb(climb: Climb | null | undefined): Climb {
  return {
    uuid: climb?.uuid ?? '',
    angle: climb?.angle ?? 0,
    boardType: climb?.boardType,
    layoutId: climb?.layoutId,
    mirrored: climb?.mirrored,
    name: '',
    setter_username: '',
    frames: '',
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}

export function sanitizeQueueItem(item: ClimbQueueItem): ClimbQueueItem {
  return { uuid: item.uuid, suggested: item.suggested, climb: sanitizeQueueClimb(item.climb) };
}

/** Keep a composer's target identity so withdrawing copied metadata keeps its draft mounted. */
export function sanitizeClimbTarget<Target extends { climb: Climb }>(
  target: Target,
): Omit<Target, 'climb'> & { climb: Climb } {
  return { ...target, climb: sanitizeQueueClimb(target.climb) };
}

type QueueSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource?: PlaylistSuggestionSource | null;
};

/** Preserve the climber's list and current slot, including a current-only item. */
export function sanitizeQueueSnapshot<Snapshot extends QueueSnapshot>(
  snapshot: Snapshot,
): Omit<Snapshot, keyof QueueSnapshot> & Required<QueueSnapshot> {
  const queue = (Array.isArray(snapshot.queue) ? snapshot.queue : [])
    .filter((item) => item?.uuid)
    .map(sanitizeQueueItem);
  const current = snapshot.currentClimbQueueItem;
  return {
    ...snapshot,
    queue,
    currentClimbQueueItem: current
      ? (queue.find((item) => item.uuid === current.uuid) ?? sanitizeQueueItem(current))
      : null,
    playlistSuggestionSource: null,
  };
}
