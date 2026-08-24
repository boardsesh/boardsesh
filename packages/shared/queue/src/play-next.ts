/**
 * "Play next" placement maths — pure, no React, no I/O.
 *
 * Given the live queue, the current climb, and a target, this decides whether
 * the climb has to be INSERTED at a position, MOVED from where it already sits,
 * or left alone because it is already up next. Callers turn that plan into the
 * matching mutation (`addQueueItem(item, position)` / `reorderQueueItem(...)`),
 * which is also what peers receive over the session subscription.
 *
 * NOTE for future readers: `insertQueueItemAfterCurrent` (playlist-suggestions.ts)
 * deliberately APPENDS when there is no current item; this helper deliberately
 * puts the climb at the FRONT instead. Both are correct for their caller — a
 * playlist suggestion queues behind existing work, while "Play next" has to be
 * distinguishable from "Add to queue" (with no current climb, `queue[0]` is what
 * plays next). Do not "fix" one to match the other.
 */

import type { ClimbQueue, ClimbQueueItem } from './types';

/** What a "Play next" tap resolves to against the live queue. */
export type PlayNextPlan =
  /** The climb is not in the queue: insert it at `position`. */
  | { kind: 'insert'; position: number }
  /** The climb is already queued elsewhere: move that slot, never duplicate it. */
  | { kind: 'move'; uuid: string; oldIndex: number; newIndex: number }
  /** Nothing to do — but the caller still confirms to the climber. */
  | { kind: 'unchanged'; reason: 'already-next' | 'is-current' };

/** Which queue slot a "Play next" was fired for. */
export type PlayNextTarget = {
  /**
   * The exact queue-item uuid, when the action was opened from a queue row.
   * Absent from every other surface (climb list, search, playlist, board sheet),
   * which only knows the climb.
   */
  queueItemUuid?: string;
  /** The climb's uuid — always known. */
  climbUuid: string;
};

/**
 * Where a queue add should land. An explicit union rather than a raw index:
 * the index is derived once, from live state, inside the queue provider.
 */
export type QueueAddPlacement = 'end' | 'next';

/**
 * Resolve the queue slot the target refers to.
 *
 * An explicit `queueItemUuid` wins outright. Otherwise the first item with this
 * climb uuid strictly AFTER the current climb wins, falling back to the first
 * match anywhere — so "Play next" on a climb that only exists in the history
 * pulls that entry forward instead of leaving a stale copy behind.
 */
function findTargetIndex(queue: ClimbQueue, currentIndex: number, target: PlayNextTarget): number {
  if (target.queueItemUuid !== undefined) {
    return queue.findIndex((queueItem) => queueItem.uuid === target.queueItemUuid);
  }

  const matchesClimb = (queueItem: ClimbQueueItem) => queueItem.climb.uuid === target.climbUuid;
  const afterCurrentIndex = queue.findIndex((queueItem, index) => index > currentIndex && matchesClimb(queueItem));
  if (afterCurrentIndex !== -1) return afterCurrentIndex;

  return queue.findIndex(matchesClimb);
}

/**
 * The index a BRAND-NEW queue item takes to play next.
 *
 * - No current climb (or a current climb that is not in the queue — a playlist
 *   peek, or a slot someone else removed): the head of the queue IS next, so
 *   position 0. An empty queue takes the same branch.
 * - Otherwise: directly after the current climb.
 *
 * Total, so a caller committing a fresh item never has to fall back to an
 * append it did not ask for.
 */
export function playNextInsertPosition(queue: ClimbQueue, currentClimbQueueItem: ClimbQueueItem | null): number {
  if (!currentClimbQueueItem) return 0;
  const currentIndex = queue.findIndex((queueItem) => queueItem.uuid === currentClimbQueueItem.uuid);
  return currentIndex === -1 ? 0 : currentIndex + 1;
}

/**
 * Plan a "Play next" against the live queue.
 *
 * Placement follows {@link playNextInsertPosition}.
 *
 * The move index is direction-aware and load-bearing. Both the reducer
 * (`DELTA_REORDER_QUEUE_ITEM`) and the backend resolver splice the item OUT
 * before splicing it back in, so everything after `oldIndex` shifts left by one:
 * - `oldIndex > currentIndex` → `newIndex = currentIndex + 1` (current stayed put)
 * - `oldIndex < currentIndex` → `newIndex = currentIndex` (current slid down one)
 * A flat `currentIndex + 1` lands a history item one slot too late.
 */
export function planPlayNext(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  target: PlayNextTarget,
): PlayNextPlan {
  const currentIndex = currentClimbQueueItem
    ? queue.findIndex((queueItem) => queueItem.uuid === currentClimbQueueItem.uuid)
    : -1;

  const existingIndex = findTargetIndex(queue, currentIndex, target);

  if (existingIndex === -1) {
    return { kind: 'insert', position: playNextInsertPosition(queue, currentClimbQueueItem) };
  }

  if (existingIndex === currentIndex) {
    return { kind: 'unchanged', reason: 'is-current' };
  }

  const newIndex = currentIndex === -1 ? 0 : existingIndex > currentIndex ? currentIndex + 1 : currentIndex;

  if (newIndex === existingIndex) {
    return { kind: 'unchanged', reason: 'already-next' };
  }

  return { kind: 'move', uuid: queue[existingIndex].uuid, oldIndex: existingIndex, newIndex };
}
