/**
 * Playlist suggestion utilities — pure functions with no web-specific
 * dependencies. `createPlaylistSuggestionSource` / `getQueueBoardKey` live here
 * too (shared by web + mobile); the only board-coupled bit — the climbability
 * filter — is supplied by the caller as an injected predicate so this package
 * stays dependency-free.
 */

import type { Climb, ClimbQueue, ClimbQueueItem, PlaylistSuggestionSource, PlaylistTrackPage } from './types';

const acceptEveryClimb = () => true;

/** Prepared once for an immutable loaded-results/board snapshot, before taps. */
export type PreparedPlaylistClimbs = {
  readonly inputClimbs: Climb[];
  readonly isClimbable: (climb: Climb) => boolean;
  readonly climbs: Climb[];
  readonly firstIndexByUuid: ReadonlyMap<string, number>;
};

const sourceIndices = new WeakMap<
  PlaylistSuggestionSource,
  {
    climbs: Climb[];
    firstIndexByUuid: ReadonlyMap<string, number>;
  }
>();

function indexClimbs(climbs: Climb[]): ReadonlyMap<string, number> {
  const firstIndexByUuid = new Map<string, number>();
  climbs.forEach((climb, index) => {
    if (!firstIndexByUuid.has(climb.uuid)) firstIndexByUuid.set(climb.uuid, index);
  });
  return firstIndexByUuid;
}

export function preparePlaylistClimbs(
  climbs: Climb[],
  isClimbable: (climb: Climb) => boolean = acceptEveryClimb,
): PreparedPlaylistClimbs {
  const seen = new Set<string>();
  const compatibleClimbs: Climb[] = [];
  const firstIndexByUuid = new Map<string, number>();
  for (const climb of climbs) {
    if (seen.has(climb.uuid)) continue;
    seen.add(climb.uuid);
    if (!isClimbable(climb)) continue;
    firstIndexByUuid.set(climb.uuid, compatibleClimbs.length);
    compatibleClimbs.push(climb);
  }
  return { inputClimbs: climbs, isClimbable, climbs: compatibleClimbs, firstIndexByUuid };
}

/** Sources created elsewhere keep the original scan behavior. No serialized metadata. */
export function findPlaylistClimbIndex(source: PlaylistSuggestionSource, climbUuid: string): number {
  const prepared = sourceIndices.get(source);
  return prepared?.climbs === source.climbs
    ? (prepared.firstIndexByUuid.get(climbUuid) ?? -1)
    : source.climbs.findIndex(({ uuid }) => uuid === climbUuid);
}

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

  const activatedIndex = findPlaylistClimbIndex(source, source.activatedClimbUuid);
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
 * Re-anchor a suggestion source on the climb that is actually being committed.
 *
 * A source records the climb its pass STARTED from (`activatedClimbUuid`), and
 * everything downstream — `getPlaylistSuggestedClimbs`, the peek walk in
 * `findNextQueueItemWithSuggestions`, the remaining count — measures from there.
 * That is right while the pass is walking forward from the tapped climb, and
 * wrong the moment a climber browses from A to Z and puts Z up: committing Z
 * with a source still anchored on A aims "next" at whatever followed A, which is
 * a climb the climber walked past several swipes ago.
 *
 * Returns the source unchanged when there is nothing to fix — no source, already
 * anchored here, or a climb the source does not contain (a peek from some other
 * track), since anchoring on a climb that is not in `climbs` would make the
 * whole list read as exhausted.
 */
export function reanchorPlaylistSuggestionSource(
  source: PlaylistSuggestionSource | null,
  activatedClimbUuid: string | undefined,
): PlaylistSuggestionSource | null {
  if (!source || !activatedClimbUuid) return source;
  if (source.activatedClimbUuid === activatedClimbUuid) return source;
  if (findPlaylistClimbIndex(source, activatedClimbUuid) < 0) return source;
  const reanchoredSource = { ...source, activatedClimbUuid };
  const preparedIndex = sourceIndices.get(source);
  if (preparedIndex?.climbs === source.climbs) sourceIndices.set(reanchoredSource, preparedIndex);
  return reanchoredSource;
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
 * other climb is kept only when `isClimbable(climb)` returns true.
 *
 * Mobile passes a `canAddClimbToBoard`-backed predicate (see
 * `use-playlist-activation.ts`) so a mixed-board playlist can't feed `next` a
 * climb the wall can't draw. Web has no consumer since the climbing UI moved to
 * the Expo app in W-16 (#4435). Omitting the predicate keeps everything.
 *
 * `climbs` is the list from its first climb, in the list's order. `total` is
 * kept only when the track walks exactly that list, so "4 of 23" is never a
 * wrong number: a filter that dropped a climb, a duplicate, or an activated
 * climb that had to be appended all move positions, and each clears it.
 */
export function createPlaylistSuggestionSource({
  playlistUuid,
  activatedClimb,
  climbs,
  boardKey,
  isClimbable = acceptEveryClimb,
  preparedClimbs,
  label,
  total,
  continuation,
}: {
  playlistUuid: string;
  activatedClimb: Climb;
  climbs: Climb[];
  boardKey: string;
  isClimbable?: (climb: Climb) => boolean;
  preparedClimbs?: PreparedPlaylistClimbs;
  label?: string;
  total?: number;
  continuation?: PlaylistSuggestionSource['continuation'];
}): PlaylistSuggestionSource {
  // A filtered-out or absent activated climb has exceptional inclusion/order
  // semantics. Keep that uncommon path on the original builder.
  const canReuse =
    preparedClimbs?.inputClimbs === climbs &&
    preparedClimbs.isClimbable === isClimbable &&
    preparedClimbs.firstIndexByUuid.has(activatedClimb.uuid);
  const climbableClimbs = canReuse
    ? preparedClimbs.climbs
    : mergeUniquePlaylistClimbs(activatedClimb, climbs).filter(
        (climb) => climb.uuid === activatedClimb.uuid || isClimbable(climb),
      );
  const source: PlaylistSuggestionSource = {
    playlistUuid,
    activatedClimbUuid: activatedClimb.uuid,
    boardKey,
    climbs: climbableClimbs,
  };
  if (label) source.label = label;
  if (total !== undefined && keepsListPositions(climbableClimbs, climbs, total)) source.total = total;
  if (continuation) source.continuation = continuation;
  sourceIndices.set(source, {
    climbs: climbableClimbs,
    firstIndexByUuid: canReuse ? preparedClimbs.firstIndexByUuid : indexClimbs(climbableClimbs),
  });
  return source;
}

/** True when `track` is `list` climb for climb, so an index in one is a place in the other. */
function keepsListPositions(track: Climb[], list: Climb[], total: number): boolean {
  if (track.length !== list.length || total < track.length) return false;
  for (let index = 0; index < track.length; index += 1) {
    if (track[index].uuid !== list[index].uuid) return false;
  }
  return true;
}

/**
 * The track with one more page on its end (issue #6664: lists longer than the
 * first load keep going instead of stopping at the cap).
 *
 * Climbs the track already holds are not added twice. The count survives only
 * when this page lands exactly where the track ends, nothing in it was dropped
 * and nothing in it was already there; otherwise positions past this point no
 * longer match the list, so the player stops showing them.
 */
export function appendPlaylistTrackPage(
  source: PlaylistSuggestionSource,
  page: PlaylistTrackPage,
): PlaylistSuggestionSource {
  const knownUuids = new Set(source.climbs.map(({ uuid }) => uuid));
  const appended: Climb[] = [];
  let hadDuplicates = false;
  for (const climb of page.climbs) {
    if (knownUuids.has(climb.uuid)) {
      hadDuplicates = true;
      continue;
    }
    knownUuids.add(climb.uuid);
    appended.push(climb);
  }
  const climbs = appended.length > 0 ? [...source.climbs, ...appended] : source.climbs;
  const next: PlaylistSuggestionSource = { ...source, climbs };
  const total = page.total ?? source.total;
  // An empty page moves no position (a load that failed ends the track this way).
  const pageStartsAtTrackEnd = page.climbs.length === 0 || page.page * page.pageSize === source.climbs.length;
  if (
    source.total !== undefined &&
    total !== undefined &&
    total >= climbs.length &&
    pageStartsAtTrackEnd &&
    !hadDuplicates &&
    !page.filteredOut
  ) {
    next.total = total;
  } else {
    delete next.total;
  }
  if (page.nextPage === null || !source.continuation) {
    delete next.continuation;
  } else {
    next.continuation = { loaderId: source.continuation.loaderId, nextPage: page.nextPage };
  }
  const existingIndex = sourceIndices.get(source);
  sourceIndices.set(
    next,
    existingIndex?.climbs === climbs ? existingIndex : { climbs, firstIndexByUuid: indexClimbs(climbs) },
  );
  return next;
}

/**
 * A copy of `source` walking `climbs`, a filtered subset of its own. Dropping a
 * climb moves every position after it, so the count goes with it.
 */
export function withPlaylistTrackClimbs(source: PlaylistSuggestionSource, climbs: Climb[]): PlaylistSuggestionSource {
  const next: PlaylistSuggestionSource = { ...source, climbs };
  if (climbs.length !== source.climbs.length) delete next.total;
  return next;
}
