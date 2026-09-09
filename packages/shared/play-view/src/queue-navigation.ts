import type { Climb, ClimbQueueItem, ClimbQueue, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPlaylistSuggestedClimbs, getPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
import {
  classifyClimbBoardCompatibility,
  findNextCompatibleQueueItem,
  type ActiveBoardForCompatibility,
} from '@boardsesh/board-config';
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

/** The queue neighbour on either side of `currentIndex` that already holds
 * `climbUuid`, if there is one. See the "symmetric dedupe" note on
 * findNextQueueItemWithSuggestions for why both sides count. `queue[-1]` is
 * `undefined`, so a current item at the head is handled without a guard. */
function findAdjacentQueueItemForClimb(
  queue: ClimbQueue,
  currentIndex: number,
  climbUuid: string,
): ClimbQueueItem | null {
  const before = queue[currentIndex - 1];
  if (before?.climb?.uuid === climbUuid) return before;
  const after = queue[currentIndex + 1];
  if (after?.climb?.uuid === climbUuid) return after;
  return null;
}

/** What a forward navigation resolved to, plus the queued climbs it walked past. */
export type NextQueueItemSelection = {
  item: ClimbQueueItem | null;
  /**
   * Queued climbs the active board cannot draw, in queue order, that were
   * passed over to reach `item`. Empty when no active board was supplied.
   */
  skippedItems: ClimbQueueItem[];
};

/**
 * First queued climb from `items` the active board can draw, plus the ones
 * walked past to reach it.
 *
 * `findNextCompatibleQueueItem` scans forward from the start and only ever
 * skips a contiguous run of incompatible climbs before returning, so the
 * skipped climbs are exactly the first `skippedCount` entries.
 */
function scanForFirstCompatible(
  items: ClimbQueue,
  activeConfig: ActiveBoardForCompatibility | undefined,
): NextQueueItemSelection {
  const { item, skippedCount } = findNextCompatibleQueueItem(items, null, activeConfig);
  return { item, skippedItems: items.slice(0, skippedCount) };
}

/**
 * Next-climb target for a play-drawer swipe, walking the LIST the current climb
 * was opened from rather than the queue (issue #4829).
 *
 * The queue is cross-board and accumulates browse history: every climb you tap
 * lands in it, and activation inserts right after the current item. Walking the
 * queue therefore replays leftovers from whatever list or board you were on
 * before — tap K1, K2, K3 on Kilter, swipe back to K1, switch to Woods and tap
 * W1, and a queue-first "next" hands you K2. So when the current climb is in the
 * active suggestion source (`source.climbs`), next/prev walk that ordered list;
 * only a current climb with no list (or off it) falls back to the queue.
 *
 * Three cases for a current item that IS in the queue:
 *  1. Its climb is in `source.climbs` → target is the list successor, as a
 *     transient "peek". On commit the peek is inserted even if that climb
 *     already appears elsewhere in the queue, so re-activating a playlist climb
 *     starts a fresh pass (the queue grows 1..10, 1..10) instead of jumping
 *     ahead to the first un-queued climb.
 *  2. No source, or the current climb isn't in it → the queue successor.
 *  3. List boundary (in the source, nothing after it) → fall back to the queue
 *     successor, so a queue built from other lists is still reachable.
 *
 * Symmetric dedupe: if the list target is ALREADY the queue item immediately
 * before or after current, return that real item instead of minting a peek, so
 * swiping back and forth doesn't append duplicates. Both sides matter because
 * the server always inserts after the current item and mobile verifies the
 * ORDERED queue hash: committing a *previous* peek yields `[…, W1, W0]` with W0
 * current, so the following "next" finds its list target W1 at
 * `currentIndex - 1`, not `+ 1`.
 *
 * An orphan current (not in the queue at all — the wrong-board view-only
 * preview, or transiently between a peek commit and the server echo) keeps the
 * old behaviour: peek the list successor, else null. It never falls back to
 * `queue[0]`, and it never dedupes (there is no meaningful adjacency).
 *
 * `activeConfig` makes the QUEUE branch board-aware (issue #5099): a swipe walks
 * past queued climbs the board on the wall cannot draw rather than handing back
 * a climb that renders nothing and lights nothing. Skipped climbs stay in the
 * queue and stay reachable from the queue sheet — they just stop being swipe
 * targets. Identity-only (`classifyClimbBoardCompatibility`), so a same-layout
 * different-size climb is never skipped: those still render, on their own board.
 * Omit `activeConfig`, or leave a climb without board metadata, and nothing is
 * skipped — this fails open by design.
 *
 * The SUGGESTION branch is deliberately left board-blind: the play drawer feeds
 * it a source that is sometimes bound to another board on purpose (the
 * wrong-board view-only preview). Staleness of the provider's own source is
 * handled where that source lives, not here.
 */
export function selectNextQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
): NextQueueItemSelection {
  if (currentClimbQueueItem) {
    const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
    if (currentIndex >= 0) {
      const listSuccessor = getNextPlaylistClimb(source, currentClimbQueueItem.climb?.uuid);
      if (listSuccessor) {
        return {
          item: findAdjacentQueueItemForClimb(queue, currentIndex, listSuccessor.uuid) ?? toPeekItem(listSuccessor),
          skippedItems: [],
        };
      }
      // The active list wins; board filtering applies when falling back to queue history.
      return scanForFirstCompatible(queue.slice(currentIndex + 1), activeConfig);
    }
    const nextClimb = getNextPlaylistClimb(source, currentClimbQueueItem.climb?.uuid);
    return { item: nextClimb ? toPeekItem(nextClimb) : null, skippedItems: [] };
  }

  if (queue.length > 0) {
    const scanned = scanForFirstCompatible(queue, activeConfig);
    if (scanned.item) return scanned;
    const firstSuggestionAfterQueue = getPlaylistSuggestedClimbs(source, queue)[0];
    return {
      item: firstSuggestionAfterQueue ? toPeekItem(firstSuggestionAfterQueue) : null,
      skippedItems: scanned.skippedItems,
    };
  }

  // No current climb and an empty queue: seed from the activated climb's first
  // suggestion (getPlaylistSuggestedClimbs anchors on source.activatedClimbUuid).
  const firstSuggestion = getPlaylistSuggestedClimbs(source, queue)[0];
  return { item: firstSuggestion ? toPeekItem(firstSuggestion) : null, skippedItems: [] };
}

/** `selectNextQueueItemWithSuggestions` for callers that don't report skips. */
export function findNextQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
): ClimbQueueItem | null {
  return selectNextQueueItemWithSuggestions(queue, currentClimbQueueItem, source, activeConfig).item;
}

/**
 * Previous-climb target for a play-drawer swipe — the mirror of
 * findNextQueueItemWithSuggestions, list-first for the same reason (issue
 * #4829): the cross-board queue accumulates browse history, so swiping back
 * used to walk climbs from a list or board you already left.
 *
 * Three cases for a current item that IS in the queue:
 *  1. Its climb is in `source.climbs` → the list predecessor, as a transient
 *     "peek" (or the adjacent real queue item — see the symmetric dedupe note
 *     on findNextQueueItemWithSuggestions).
 *  2. No source, or the current climb isn't in it → the queue predecessor.
 *  3. List boundary (first in the list) → fall back to the queue predecessor,
 *     so history from before the list is still reachable.
 *
 * An orphan current (not in the queue — the wrong-board view-only preview,
 * whose peeked climbs are never committed) is unchanged: peek the list
 * predecessor if the climb is in the source, else null.
 */
export function findPreviousQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
): ClimbQueueItem | null {
  if (!currentClimbQueueItem) return null;

  const currentIndex = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid);
  if (currentIndex >= 0) {
    const listPredecessor = getPreviousPlaylistClimb(source, currentClimbQueueItem.climb?.uuid);
    if (listPredecessor) {
      return findAdjacentQueueItemForClimb(queue, currentIndex, listPredecessor.uuid) ?? toPeekItem(listPredecessor);
    }
    // No list, off the list, or at the list's start: walk the queue.
    return currentIndex > 0 ? queue[currentIndex - 1] : null;
  }

  const prevClimb = getPreviousPlaylistClimb(source, currentClimbQueueItem.climb?.uuid);
  return prevClimb ? toPeekItem(prevClimb) : null;
}

/**
 * How many climbs after `currentIndex` a forward swipe can actually visit.
 *
 * The queue keeps cross-board climbs (they stay tappable in the queue sheet),
 * but a swipe walks past them, so counting them would over-report "N left" —
 * the climber would be promised swipes that never happen. With no `activeConfig`
 * nothing classifies as incompatible and this is the plain remaining count.
 */
function countDrawableAfter(
  queue: ClimbQueue,
  currentIndex: number,
  activeConfig: ActiveBoardForCompatibility | undefined,
): number {
  let count = 0;
  for (let index = currentIndex >= 0 ? currentIndex + 1 : 0; index < queue.length; index++) {
    if (classifyClimbBoardCompatibility(activeConfig, queue[index].climb) !== 'incompatible') count++;
  }
  return count;
}

/**
 * computeNavigationState over the list-first swipe rules: canNext/nextItem and
 * canPrevious/prevItem come from the active suggestion source's ordered list
 * whenever the current climb is on it (in either direction), and from the queue
 * otherwise. remainingCount stays queue-based to match web's action-bar
 * remaining count.
 *
 * `activeConfig` is forwarded to the forward scan and to `remainingCount`, so
 * `canNext`, the header peek and "N left" all agree with the climb a swipe
 * actually lands on. Backward navigation is deliberately
 * left alone: swiping back should return you where you came from, and a
 * cross-board climb reached that way is drawn on its own board.
 */
export function computeNavigationStateWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
): NavigationState {
  const nextItem = selectNextQueueItemWithSuggestions(queue, currentClimbQueueItem, source, activeConfig).item;
  const prevItem = findPreviousQueueItemWithSuggestions(queue, currentClimbQueueItem, source);

  const currentIndex = currentClimbQueueItem ? queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid) : -1;
  const remainingCount = countDrawableAfter(queue, currentIndex, activeConfig);

  return {
    canNext: nextItem !== null,
    canPrevious: prevItem !== null,
    nextItem,
    prevItem,
    remainingCount,
  };
}

/**
 * The next `count` swipe targets after `currentClimbQueueItem`, in the order a
 * climber would reach them — the same walk `findNextQueueItemWithSuggestions`
 * does for one step, repeated with each result as the next step's current item.
 *
 * Written for the play drawer's render prefetch (issue #5187): warming the
 * board renders for the climbs just ahead turns the next few swipes into cache
 * hits. Nothing here mutates the queue and nothing is committed — a peek item
 * this returns is the same transient item a swipe would have minted.
 *
 * Stops early at the end of the walk (fewer than `count` items), and at the
 * first target it has already returned. Both an item uuid and a climb uuid
 * count as "already seen". A repeated ITEM uuid ends the walk: a playlist
 * peek's uuid is derived from its climb, so a list that loops back would
 * otherwise walk forever. A repeated CLIMB uuid is skipped, not fatal: a queue
 * that holds the same climb twice (re-activating a playlist appends a fresh
 * pass) still has new climbs past the duplicate, whose renders are worth
 * warming; the duplicate itself is already warm. The walk is bounded by
 * `count + queue.length` steps so a skipped duplicate can never loop.
 */
export function findUpcomingQueueItemsWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  count: number,
  activeConfig?: ActiveBoardForCompatibility,
): ClimbQueueItem[] {
  const upcomingItems: ClimbQueueItem[] = [];
  if (count <= 0) return upcomingItems;

  const seenItemUuids = new Set<string>();
  const seenClimbUuids = new Set<string>();
  if (currentClimbQueueItem) {
    seenItemUuids.add(currentClimbQueueItem.uuid);
    const currentClimbUuid = currentClimbQueueItem.climb?.uuid;
    if (currentClimbUuid) seenClimbUuids.add(currentClimbUuid);
  }

  let walkFrom = currentClimbQueueItem;
  let stepsLeft = count + queue.length;
  while (upcomingItems.length < count && stepsLeft > 0) {
    stepsLeft -= 1;
    const nextItem = findNextQueueItemWithSuggestions(queue, walkFrom, source, activeConfig);
    if (!nextItem) break;
    if (seenItemUuids.has(nextItem.uuid)) break;
    seenItemUuids.add(nextItem.uuid);
    walkFrom = nextItem;
    const nextClimbUuid = nextItem.climb?.uuid;
    if (nextClimbUuid !== undefined && seenClimbUuids.has(nextClimbUuid)) continue;
    if (nextClimbUuid) seenClimbUuids.add(nextClimbUuid);
    upcomingItems.push(nextItem);
  }

  return upcomingItems;
}
