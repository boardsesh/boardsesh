/**
 * Playlist suggestion utilities — pure functions with no web-specific
 * dependencies. `createPlaylistSuggestionSource` / `getQueueBoardKey` live here
 * too (shared by web + mobile); the only board-coupled bit — the climbability
 * filter — is supplied by the caller as an injected predicate so this package
 * stays dependency-free.
 */

import type { Climb, ClimbQueue, ClimbQueueItem, PlaylistSuggestionSource } from './types';

/**
 * Merge a list of playlist climbs with the activated climb, deduplicating
 * by uuid and ensuring the activated climb is always included.
 */
export function mergeUniquePlaylistClimbs(activatedClimb: Climb, climbs: Climb[]): Climb[] {
  const seen = new Set<string>();
  const merged: Climb[] = [];
  let includesActivatedClimb = false;

  for (const climb of climbs) {
    if (seen.has(climb.uuid)) continue;
    if (climb.uuid === activatedClimb.uuid) {
      includesActivatedClimb = true;
    }
    seen.add(climb.uuid);
    merged.push(climb);
  }

  if (!includesActivatedClimb) {
    merged.push(activatedClimb);
  }

  return merged;
}

/**
 * Check whether two playlist suggestion sources refer to the same playlist
 * activation (same playlist, same activated climb, same board key).
 */
export function playlistSuggestionSourceMatches(
  current: PlaylistSuggestionSource | null,
  next: PlaylistSuggestionSource,
): boolean {
  return (
    current?.playlistUuid === next.playlistUuid &&
    current?.activatedClimbUuid === next.activatedClimbUuid &&
    current?.boardKey === next.boardKey
  );
}

/**
 * Return the list of climbs from a playlist suggestion source that come after
 * the activated climb and are not already in the queue.
 */
export function getPlaylistSuggestedClimbs(source: PlaylistSuggestionSource | null, queue: ClimbQueue): Climb[] {
  if (!source) return [];

  const activatedIndex = source.climbs.findIndex((climb) => climb.uuid === source.activatedClimbUuid);
  if (activatedIndex === -1) return [];
  const startIndex = activatedIndex + 1;
  const queuedClimbUuids = new Set(queue.map((item) => item.climb?.uuid).filter((uuid): uuid is string => !!uuid));
  const seen = new Set<string>();
  const suggestions: Climb[] = [];

  for (const climb of source.climbs.slice(startIndex)) {
    if (queuedClimbUuids.has(climb.uuid) || seen.has(climb.uuid)) continue;
    seen.add(climb.uuid);
    suggestions.push(climb);
  }

  return suggestions;
}

/**
 * After navigating to a new current item, prune suggested items that appear
 * after the current item in the queue. Non-suggested items are preserved.
 */
export function pruneSuggestedQueueItemsAfterCurrent(queue: ClimbQueue, currentItem: ClimbQueueItem): ClimbQueue {
  const currentIndex = queue.findIndex((queueItem) => queueItem.uuid === currentItem.uuid);
  if (currentIndex === -1) {
    return queue;
  }

  return [
    ...queue.slice(0, currentIndex + 1),
    ...queue.slice(currentIndex + 1).filter((queueItem) => !queueItem.suggested),
  ];
}

/**
 * Generate a deterministic queue-item uuid for playlist peek items.
 */
export function getPlaylistPeekQueueItemUuid(climbUuid: string): string {
  return `playlist-peek:${climbUuid}`;
}

/**
 * Check whether a queue-item uuid is a playlist peek uuid.
 */
export function isPlaylistPeekQueueItemUuid(queueItemUuid: string): boolean {
  return queueItemUuid.startsWith('playlist-peek:');
}

/**
 * Minimal board identity needed to key a playlist activation to a board.
 * Web's `BoardDetails` structurally satisfies this (board_name / layout_id /
 * size_id / set_ids); mobile passes the same fields off its active board.
 */
export type QueueBoardKeyTarget = {
  board_name: string;
  layout_id: number;
  size_id: number;
  set_ids: number[] | number | string;
};

/**
 * Build a stable key identifying the board a playlist activation is bound to.
 * Two activations on different boards never share a suggestion source.
 */
export function getQueueBoardKey(target: QueueBoardKeyTarget): string {
  const setIds = Array.isArray(target.set_ids) ? target.set_ids.join(',') : String(target.set_ids);
  return `${target.board_name}:${target.layout_id}:${target.size_id}:${setIds}`;
}

/**
 * Construct a PlaylistSuggestionSource from the activated climb plus the
 * visible/fetched playlist climbs. The activated climb is always kept; every
 * other climb is kept only when `isClimbable(climb)` returns true. Web passes a
 * `canAddClimbToBoard`-backed predicate; mobile (single active board) can omit
 * it (defaults to keeping everything).
 */
export function createPlaylistSuggestionSource({
  playlistUuid,
  activatedClimb,
  climbs,
  boardKey,
  isClimbable = () => true,
}: {
  playlistUuid: string;
  activatedClimb: Climb;
  climbs: Climb[];
  boardKey: string;
  isClimbable?: (climb: Climb) => boolean;
}): PlaylistSuggestionSource {
  const climbableClimbs = mergeUniquePlaylistClimbs(activatedClimb, climbs).filter(
    (climb) => climb.uuid === activatedClimb.uuid || isClimbable(climb),
  );
  return {
    playlistUuid,
    activatedClimbUuid: activatedClimb.uuid,
    boardKey,
    climbs: climbableClimbs,
  };
}
