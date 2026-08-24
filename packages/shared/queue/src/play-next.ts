/**
 * "Play next" placement maths — pure, no React, no I/O.
 *
 * Given the live queue, the current climb, and a target, this decides whether
 * the climb has to be INSERTED at a position, MOVED from where it already sits,
 * or left alone because it is already up next. Callers turn that plan into the
 * matching mutation (`addQueueItem(item, position)` / `reorderQueueItem(...)`),
 * which is also what peers receive over the session subscription.
 *
 * NOTE on the orphan-current case, because a sibling looks like it disagrees:
 * the reducer's `insertAfterCurrent` flag (`SET_CURRENT_CLIMB`) appends when the
 * current climb is not in the queue, where this file inserts at index 0. Both
 * are right, because they answer different questions. There, the inserted climb
 * *becomes* the current one, so its slot never decides what plays next and an
 * append is harmless. Here the climb has to end up ahead of the queue, and index
 * 0 is the best available slot (see `playNextInsertPosition`). Do not "fix"
 * either to match the other.
 *
 * `insertQueueItemAfterCurrent` used to be the third answer to this question. It
 * appended for an orphan current, had no callers, and was deleted with this
 * feature rather than left as a trap for whoever read it next.
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
 * - **No current climb at all** (`null`), empty queue included → `0`. Here 0
 *   really is next: `findNextQueueItemWithSuggestions` (`@boardsesh/play-view`)
 *   returns `queue[0]` when there is no current item.
 * - **Current climb set and present in the queue** → directly after it.
 * - **Current climb set but NOT in the queue** — an uncommitted playlist peek, or
 *   a slot a peer removed → `0`, as the best available landing slot. NOT because
 *   0 is what plays next: with an orphan current pointer
 *   `findNextQueueItemWithSuggestions` falls through to the playlist peek (or
 *   `null`) and never consults `queue[0]`, so forward navigation will not reach
 *   this climb until the current item rejoins the queue. The head is simply the
 *   least-bad slot — appending buries the climb behind everything instead.
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

  // Both arms are `playNextInsertPosition(queue, currentClimbQueueItem)` by
  // construction — `currentIndex + 1` when current is in the queue, `0` when it
  // is not — restated here only because the forward arm needs the post-removal
  // correction the helper (which places a NEW item) must not apply. Change one
  // and change the other; the orphan-current move test pins them together.
  const newIndex = currentIndex === -1 ? 0 : existingIndex > currentIndex ? currentIndex + 1 : currentIndex;

  if (newIndex === existingIndex) {
    return { kind: 'unchanged', reason: 'already-next' };
  }

  return { kind: 'move', uuid: queue[existingIndex].uuid, oldIndex: existingIndex, newIndex };
}
