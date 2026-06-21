import type { Climb, ClimbQueueItem, ClimbQueue, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPlaylistSuggestedClimbs, getPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
import type { NavigationState } from './types';

/**
 * Find the next item in the queue relative to the current climb.
 * Returns null if there is no next item.
 */
export function findNextQueueItem(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
): ClimbQueueItem | null {
  if (queue.length === 0) return null;
  if (!currentClimbQueueItem) return queue[0];

  const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  const nextIndex = currentIndex + 1;

  if (nextIndex < queue.length) {
    return queue[nextIndex];
  }

  return null;
}

/**
 * Find the previous item in the queue relative to the current climb.
 * Returns null if there is no previous item.
 */
export function findPreviousQueueItem(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
): ClimbQueueItem | null {
  if (queue.length === 0 || !currentClimbQueueItem) return null;

  const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  const prevIndex = currentIndex - 1;

  if (prevIndex >= 0) {
    return queue[prevIndex];
  }

  return null;
}

/**
 * Compute full navigation state from queue and current item.
 * Used by both web and mobile to derive action bar props.
 */
export function computeNavigationState(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
): NavigationState {
  const nextItem = findNextQueueItem(queue, currentClimbQueueItem);
  const prevItem = findPreviousQueueItem(queue, currentClimbQueueItem);

  const currentIndex = currentClimbQueueItem ? queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid) : -1;

  const remainingCount = currentIndex >= 0 ? queue.length - currentIndex - 1 : queue.length;

  return {
    canNext: nextItem !== null,
    canPrevious: prevItem !== null,
    nextItem,
    prevItem,
    remainingCount,
  };
}

/** The playlist climb immediately after `currentClimbUuid` in the source's
 * ordered list, or null if the current climb isn't in the playlist or is last. */
function getNextPlaylistClimb(
  source: PlaylistSuggestionSource | null,
  currentClimbUuid: string | undefined,
): Climb | null {
  if (!source || !currentClimbUuid) return null;
  const index = source.climbs.findIndex((climb) => climb.uuid === currentClimbUuid);
  if (index === -1) return null;
  return source.climbs[index + 1] ?? null;
}

/** The playlist climb immediately before `currentClimbUuid` in the source's
 * ordered list, or null if the current climb isn't in the playlist or is first. */
function getPreviousPlaylistClimb(
  source: PlaylistSuggestionSource | null,
  currentClimbUuid: string | undefined,
): Climb | null {
  if (!source || !currentClimbUuid) return null;
  const index = source.climbs.findIndex((climb) => climb.uuid === currentClimbUuid);
  if (index <= 0) return null;
  return source.climbs[index - 1] ?? null;
}

/** Wrap a suggested climb as a transient "peek" queue item. */
function toPeekItem(climb: Climb): ClimbQueueItem {
  return { climb, addedBy: null, uuid: getPlaylistPeekQueueItemUuid(climb.uuid), suggested: true };
}

/**
 * Like findNextQueueItem, but when the queue is exhausted relative to the
 * current item, fall through to the next PLAYLIST climb — the one immediately
 * after the CURRENT climb in the suggestion source's ordered list — as a
 * transient "peek" item. On commit the peek is appended to the queue even if
 * that climb already appears earlier, so re-activating a playlist climb starts a
 * fresh pass that re-appends the rest of the playlist (the queue grows
 * 1..10, 1..10) instead of jumping ahead to the first un-queued climb.
 *
 * Queue-first: while the current item has a real successor in the queue we
 * return that, so swiping back then forward walks the existing queue without
 * duplicating. Only at the tail — or for an orphan current (transiently between
 * a peek commit and the server echo) — do we fall through to the playlist.
 */
export function findNextQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
): ClimbQueueItem | null {
  if (currentClimbQueueItem) {
    const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
    if (currentIndex >= 0 && currentIndex < queue.length - 1) {
      return queue[currentIndex + 1];
    }
    const nextClimb = getNextPlaylistClimb(source, currentClimbQueueItem.climb?.uuid);
    return nextClimb ? toPeekItem(nextClimb) : null;
  }

  if (queue.length > 0) return queue[0];

  // No current climb and an empty queue: seed from the activated climb's first
  // suggestion (getPlaylistSuggestedClimbs anchors on source.activatedClimbUuid).
  const firstSuggestion = getPlaylistSuggestedClimbs(source, queue)[0];
  return firstSuggestion ? toPeekItem(firstSuggestion) : null;
}

/**
 * Like findPreviousQueueItem, but when the current item isn't in the queue at
 * all, fall through to the PREVIOUS playlist climb (the one immediately before
 * the current climb in the suggestion source's ordered list) as a transient
 * "peek" item — the mirror of findNextQueueItemWithSuggestions.
 *
 * This only matters for the wrong-board view-only preview, where peeked climbs
 * are shown but never committed to the queue, so they have no queue predecessor
 * to walk back to. Queue-first: while the current item IS in the queue we return
 * its queue predecessor (or null at the head) exactly like findPreviousQueueItem,
 * so the committed active-board path never peeks backward into the playlist.
 */
export function findPreviousQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
): ClimbQueueItem | null {
  if (!currentClimbQueueItem) return null;

  const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  if (currentIndex >= 0) {
    return currentIndex > 0 ? queue[currentIndex - 1] : null;
  }

  const prevClimb = getPreviousPlaylistClimb(source, currentClimbQueueItem.climb?.uuid);
  return prevClimb ? toPeekItem(prevClimb) : null;
}

/**
 * computeNavigationState that lights up canNext/nextItem from playlist
 * suggestions when the queue is exhausted, and canPrevious/prevItem from
 * suggestions when the current climb isn't in the queue at all (the wrong-board
 * view-only preview, whose peeked climbs are never committed to the queue). For
 * a current climb that IS in the queue, prev stays queue-only — the committed
 * active-board path never peeks backward into the playlist. remainingCount stays
 * queue-based to match web's action-bar remaining count.
 */
export function computeNavigationStateWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
): NavigationState {
  const nextItem = findNextQueueItemWithSuggestions(queue, currentClimbQueueItem, source);
  const prevItem = findPreviousQueueItemWithSuggestions(queue, currentClimbQueueItem, source);

  const currentIndex = currentClimbQueueItem ? queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid) : -1;
  const remainingCount = currentIndex >= 0 ? queue.length - currentIndex - 1 : queue.length;

  return {
    canNext: nextItem !== null,
    canPrevious: prevItem !== null,
    nextItem,
    prevItem,
    remainingCount,
  };
}
