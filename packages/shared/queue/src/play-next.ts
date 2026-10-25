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
import { upNextStart } from './now-slot';

/** What a "Play next" tap resolves to against the live queue. */
export type PlayNextPlan =
  /** The climb is not in the queue: insert it at `position`. */
  | { kind: 'insert'; position: number }
  /** The climb is already queued elsewhere: move that slot, never duplicate it. */
  | { kind: 'move'; uuid: string; oldIndex: number; newIndex: number }
  /**
   * F3, nothing current, the climb is in History: no single reorder can make it
   * the head of Up next (see {@link planPlayNext}), so the caller replaces the
   * whole queue in one write (`setQueue` with `historyCount`). `queue` has the
   * entry pulled out of History and put at the head of Up next; `historyCount`
   * is the new line, one lower, which is also the index the entry lands at.
   */
  | { kind: 'replace'; uuid: string; oldIndex: number; queue: ClimbQueue; historyCount: number }
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
function findTargetIndex(queue: ClimbQueue, historyEnd: number, target: PlayNextTarget): number {
  if (target.queueItemUuid !== undefined) {
    return queue.findIndex((queueItem) => queueItem.uuid === target.queueItemUuid);
  }

  const matchesClimb = (queueItem: ClimbQueueItem) => queueItem.climb.uuid === target.climbUuid;
  const afterCurrentIndex = queue.findIndex((queueItem, index) => index > historyEnd && matchesClimb(queueItem));
  if (afterCurrentIndex !== -1) return afterCurrentIndex;

  return queue.findIndex(matchesClimb);
}

/**
 * The index a BRAND-NEW queue item takes to play next: `upNextStart`.
 *
 * - **Current climb set and present in the queue** → directly after it.
 * - **No current climb** (`null`), empty queue included → the History / Up next
 *   line, `historyCount` (F3, now-slot mode). In legacy mode `historyCount` is
 *   null and this is `0`, which really is next there:
 *   `findNextQueueItemWithSuggestions` (`@boardsesh/play-view`) returns
 *   `queue[0]` when there is no current item.
 * - **Current climb set but NOT in the queue** — an uncommitted playlist peek, or
 *   a slot a peer removed → the line too (`0` in legacy mode), as the best
 *   available landing slot. NOT because it is what plays next: with an orphan
 *   current pointer `findNextQueueItemWithSuggestions` falls through to the
 *   playlist peek (or `null`) and never consults the queue, so forward
 *   navigation will not reach this climb until the current item rejoins the
 *   queue. The head of Up next is simply the least-bad slot — appending buries
 *   the climb behind everything instead.
 *
 * Total, so a caller committing a fresh item never has to fall back to an
 * append it did not ask for.
 */
export function playNextInsertPosition(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  historyCount?: number | null,
): number {
  return upNextStart(queue, currentClimbQueueItem, historyCount);
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
 *
 * With nothing current the target index is the line, `historyCount` (0 in
 * legacy mode). An Up next entry moves to the head of Up next. A History entry
 * can't get there with one reorder: the shared line rule (`lineAfterDelta`)
 * files an entry that lands at `historyCount - 1` under History, and one that
 * lands at `historyCount` as Up next's SECOND entry (with Up next empty that
 * index is past the end, and the resolver rejects it). So a History entry gets
 * a `replace` plan instead: the queue with that entry at the head of Up next and
 * the line one lower, sent as one `setQueue`.
 */
export function planPlayNext(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  target: PlayNextTarget,
  historyCount?: number | null,
): PlayNextPlan {
  const currentIndex = currentClimbQueueItem
    ? queue.findIndex((queueItem) => queueItem.uuid === currentClimbQueueItem.uuid)
    : -1;
  const firstUpNextIndex = upNextStart(queue, currentClimbQueueItem, historyCount);

  const existingIndex = findTargetIndex(queue, firstUpNextIndex - 1, target);

  if (existingIndex === -1) {
    return { kind: 'insert', position: firstUpNextIndex };
  }

  if (existingIndex === currentIndex) {
    return { kind: 'unchanged', reason: 'is-current' };
  }

  if (currentIndex === -1 && existingIndex < firstUpNextIndex) {
    const nextQueue = [...queue];
    const [movedItem] = nextQueue.splice(existingIndex, 1);
    const nextLine = firstUpNextIndex - 1;
    nextQueue.splice(nextLine, 0, movedItem);
    return { kind: 'replace', uuid: movedItem.uuid, oldIndex: existingIndex, queue: nextQueue, historyCount: nextLine };
  }

  // With a climb current, both arms are `playNextInsertPosition` by
  // construction — `currentIndex + 1` — restated here only because the forward
  // arm needs the post-removal correction the helper (which places a NEW item)
  // must not apply. Change one and change the other; the orphan-current move
  // test pins them together.
  const newIndex =
    currentIndex === -1 ? firstUpNextIndex : existingIndex > currentIndex ? currentIndex + 1 : currentIndex;

  if (newIndex === existingIndex) {
    return { kind: 'unchanged', reason: 'already-next' };
  }

  return { kind: 'move', uuid: queue[existingIndex].uuid, oldIndex: existingIndex, newIndex };
}
