import type {
  Climb,
  ClimbQueueItem,
  ClimbQueue,
  PlaylistSuggestionSource,
  PlaylistTrackResume,
} from '@boardsesh/queue';
import {
  getPlaylistSuggestedClimbs,
  getPlaylistPeekQueueItemUuid,
  findPlaylistClimbIndex,
  withPlaylistTrackResume,
} from '@boardsesh/queue';
import {
  classifyClimbBoardCompatibility,
  findNextCompatibleQueueItem,
  type ActiveBoardForCompatibility,
} from '@boardsesh/board-config';
import type { NavigationState } from './types';

/**
 * Is a queued climb the active board cannot draw still somewhere the climber can
 * get to — another wall in the same room, rather than a board in another city?
 *
 * Injected, never imported: knowing which walls stand at this gym needs a
 * network round trip and a gym identity, and this package is pure. Omit it and
 * every board-foreign climb is skipped exactly as before (issue #5099).
 */
export type ReachableClimbPredicate = (climb: Climb) => boolean;

/** Render-time index for an immutable queue snapshot. First occurrences win. */
export type PreparedQueueNavigation = {
  readonly queue: ClimbQueue;
  readonly firstIndexByUuid: ReadonlyMap<string, number>;
};

export function prepareQueueNavigation(queue: ClimbQueue): PreparedQueueNavigation {
  const firstIndexByUuid = new Map<string, number>();
  queue.forEach((item, index) => {
    if (!firstIndexByUuid.has(item.uuid)) firstIndexByUuid.set(item.uuid, index);
  });
  return { queue, firstIndexByUuid };
}

function findQueueIndexOfEntry(queue: ClimbQueue, itemUuid: string, prepared?: PreparedQueueNavigation): number {
  return prepared?.queue === queue
    ? (prepared.firstIndexByUuid.get(itemUuid) ?? -1)
    : queue.findIndex(({ uuid }) => uuid === itemUuid);
}

function findCurrentQueueIndex(
  queue: ClimbQueue,
  currentItem: ClimbQueueItem,
  prepared?: PreparedQueueNavigation,
): number {
  return findQueueIndexOfEntry(queue, currentItem.uuid, prepared);
}

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
    atTrackEnd: false,
  };
}

/** Where `climbUuid` sits on the track, or -1 with no track or off it. */
function trackIndexOf(source: PlaylistSuggestionSource | null, climbUuid: string | undefined): number {
  if (!source || !climbUuid) return -1;
  return findPlaylistClimbIndex(source, climbUuid);
}

/** Wrap a suggested climb as a transient "peek" queue item. */
function toPeekItem(climb: Climb): ClimbQueueItem {
  return { climb, addedBy: null, uuid: getPlaylistPeekQueueItemUuid(climb.uuid), suggested: true };
}

/**
 * Where the climb being navigated from stands on a track (issue #6777).
 *
 * - `off`: the track does not steer this climb. No track, or the climb is off
 *   it and the walk is not in Up next.
 * - `list`: on the list, at `trackIndex`.
 * - `upNext`: playing Up next in the middle of the list. `resume` is the list
 *   climb the walk left from, at `resumeIndex` on the track, and the list picks
 *   up after it once Up next is played.
 */
export type TrackPosition =
  | { kind: 'off' }
  | { kind: 'list'; trackIndex: number }
  | { kind: 'upNext'; resume: PlaylistTrackResume; resumeIndex: number };

const OFF_TRACK: TrackPosition = { kind: 'off' };

/**
 * Where `currentItem` stands on `source` (see {@link TrackPosition}).
 *
 * Up next needs the climb to be a real queue entry other than the one the walk
 * left from: stepping back onto that entry is being on the list again, and a
 * preview (not in the queue) only ever walks its list, so a crew browse or a
 * wrong-board look never plays anyone's Up next.
 *
 * A stale `resume` never puts a climb in Up next that the walk can't be
 * playing there: an entry the list walk put in the queue itself is the list
 * (see {@link isListWalkEntry}), and a queue entry at or before the one the
 * walk left from is History. Both happen when something other than Next or
 * Previous moves the current climb (a crewmate's move onto a later list
 * climb), and both read as the list, or off it, as they did before #6777. An
 * entry it left from that is gone from the queue (a crewmate removed it) still
 * counts as left behind: the list knows where it picks up from the track.
 */
export function resolveTrackPosition(
  queue: ClimbQueue,
  currentItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  prepared?: PreparedQueueNavigation,
): TrackPosition {
  const climbUuid = currentItem?.climb?.uuid;
  if (!source || !currentItem || !climbUuid) return OFF_TRACK;
  const { resume } = source;
  if (resume && resume.queueItemUuid !== currentItem.uuid && !isListWalkEntry(currentItem, source)) {
    const resumeIndex = trackIndexOf(source, resume.climbUuid);
    const currentIndex = findCurrentQueueIndex(queue, currentItem, prepared);
    if (
      resumeIndex >= 0 &&
      currentIndex >= 0 &&
      findQueueIndexOfEntry(queue, resume.queueItemUuid, prepared) < currentIndex
    ) {
      return { kind: 'upNext', resume, resumeIndex };
    }
  }
  const trackIndex = trackIndexOf(source, climbUuid);
  return trackIndex >= 0 ? { kind: 'list', trackIndex } : OFF_TRACK;
}

/**
 * The list climb a walk is at: the climb itself on the list, the one it picks
 * up after while it plays Up next, null off the list. What paging a track and
 * any other "how far down the list" question should measure from, rather than
 * the queued climb on screen (issue #6777).
 */
export function resolveTrackListClimbUuid(
  position: TrackPosition,
  source: PlaylistSuggestionSource | null,
): string | null {
  if (position.kind === 'upNext') return position.resume.climbUuid;
  if (position.kind === 'list') return source?.climbs[position.trackIndex]?.uuid ?? null;
  return null;
}

/**
 * A queue entry the list walk itself put there, not one anybody queued: a list
 * tap or a committed swipe is flagged `suggested`, and its climb is on the
 * track. Swiping back down a list commits each climb after the current one, so
 * those climbs sit in the queue after it; they are the list, walked by the
 * list's own rule, and never Up next ahead of it. A `suggested` climb from
 * another list (a workout's climbs, an older list's leftovers) is not on this
 * track, so it is Up next like anything else queued (issue #6777).
 */
function isListWalkEntry(item: ClimbQueueItem, source: PlaylistSuggestionSource): boolean {
  const climbUuid = item.climb?.uuid;
  return item.suggested === true && climbUuid !== undefined && trackIndexOf(source, climbUuid) >= 0;
}

/** Up next as a list walk plays it: the queue after `currentIndex`, list-walk entries left out. */
function upNextQueueItems(queue: ClimbQueue, currentIndex: number, source: PlaylistSuggestionSource): ClimbQueue {
  const upNext: ClimbQueue = [];
  for (let index = currentIndex + 1; index < queue.length; index += 1) {
    const item = queue[index];
    if (!isListWalkEntry(item, source)) upNext.push(item);
  }
  return upNext;
}

/**
 * "Up next · 1 of 3": where the climb on screen sits in the stretch of Up next
 * the walk is playing (issue #6777), or null when it is not playing Up next or
 * the stretch can't be counted (the entry it left from is gone from the queue).
 *
 * `position` counts the Up next climbs from the one the walk left from up to
 * this one. `total` adds the ones still ahead, up to the list's next climb: a
 * queued copy of it is where the list carries on, not more Up next.
 *
 * Both count only climbs the walk plays: `activeConfig` and `isReachable` are
 * the selectors' own, so a queued climb this wall can't draw (in a crew whose
 * queue mixes boards) is walked past here as it is by Next.
 */
export function resolveUpNextProgress(
  queue: ClimbQueue,
  currentItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  prepared?: PreparedQueueNavigation,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
): { position: number; total: number } | null {
  const position = resolveTrackPosition(queue, currentItem, source, prepared);
  if (position.kind !== 'upNext' || !source || !currentItem) return null;
  const currentIndex = findCurrentQueueIndex(queue, currentItem, prepared);
  let played = 1;
  let foundResume = false;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (item.uuid === position.resume.queueItemUuid) {
      foundResume = true;
      break;
    }
    if (!isListWalkEntry(item, source) && !swipeWalksPast(item, activeConfig, isReachable)) played += 1;
  }
  if (!foundResume) return null;
  const listSuccessorUuid = source.climbs[position.resumeIndex + 1]?.uuid;
  let ahead = 0;
  for (const item of upNextQueueItems(queue, currentIndex, source)) {
    if (swipeWalksPast(item, activeConfig, isReachable)) continue;
    if (item.climb?.uuid === listSuccessorUuid) break;
    ahead += 1;
  }
  return { position: played, total: played + ahead };
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

/**
 * A queued climb a swipe walks past: the board on the wall can't draw it, and
 * it is not on another wall in this room. The queue walk's own rule
 * ({@link scanForFirstCompatible}), asked one entry at a time.
 */
function swipeWalksPast(
  item: ClimbQueueItem,
  activeConfig: ActiveBoardForCompatibility | undefined,
  isReachable: ReachableClimbPredicate | undefined,
): boolean {
  if (!item.climb || classifyClimbBoardCompatibility(activeConfig, item.climb) !== 'incompatible') return false;
  return !isReachable?.(item.climb);
}

/**
 * The queue entry that already holds the list's next (`step` 1) or previous
 * (`step` -1) climb, so a swipe lands on it instead of minting a copy.
 *
 * The immediate neighbours first (the symmetric dedupe on
 * findNextQueueItemWithSuggestions). Then on along the queue in the swipe's
 * direction, past climbs the board can't draw, which the track left out for
 * the same reason (issue #6664). "Start playlist" queues the whole list in its
 * order, and on a list that mixes layouts a climb from another layout can sit
 * between two of the list's climbs: without this, every swipe past one added
 * a second copy of the next climb. The walk stops at the first climb the board
 * can draw, so a climb queued on purpose ("Play next") is never walked past.
 *
 * `aheadOnly` leaves out the neighbour behind: picking the list up after Up
 * next, an entry behind the current climb is one the walk already played
 * before it (History, or the list climb Up next was played from), and
 * stepping back onto it would play everything after it a second time.
 */
function findQueuedListNeighbour(
  queue: ClimbQueue,
  currentIndex: number,
  climbUuid: string,
  step: 1 | -1,
  activeConfig: ActiveBoardForCompatibility | undefined,
  isReachable: ReachableClimbPredicate | undefined,
  aheadOnly = false,
): ClimbQueueItem | null {
  if (currentIndex < 0) return null;
  if (!aheadOnly) {
    const adjacentItem = findAdjacentQueueItemForClimb(queue, currentIndex, climbUuid);
    if (adjacentItem || !activeConfig) return adjacentItem;
  }
  for (let index = currentIndex + step; index >= 0 && index < queue.length; index += step) {
    const item = queue[index];
    if (item.climb?.uuid === climbUuid) return item;
    if (!swipeWalksPast(item, activeConfig, isReachable)) return null;
  }
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
  /**
   * `item` is null because the current climb is the last on the track. Never
   * true with an item, and never true without a track: a climb with no list to
   * walk has nothing to end.
   */
  atTrackEnd: boolean;
  /**
   * What the track's `resume` becomes once `item` is current (issue #6777): the
   * list climb the walk leaves when it steps into Up next, null when it steps
   * onto the list, absent when the step walks no list or stays where it is
   * (another Up next climb keeps the same resume). A caller that commits the
   * step stores it on the track (`withPlaylistTrackResume`), so the list picks
   * up in the right place after the queue.
   */
  trackResume?: PlaylistTrackResume | null;
};

const NOTHING_NEXT: NextQueueItemSelection = { item: null, skippedItems: [], atTrackEnd: false };
const TRACK_END: NextQueueItemSelection = { item: null, skippedItems: [], atTrackEnd: true };

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
  isReachable?: ReachableClimbPredicate,
): NextQueueItemSelection {
  const { item, skippedCount } = findNextCompatibleQueueItem(items, null, activeConfig);
  if (!isReachable) return { item, skippedItems: items.slice(0, skippedCount), atTrackEnd: false };

  // A reachable climb earlier in the queue outranks a compatible one further
  // along: the climber asked for the wall twenty metres away, so walking past it
  // to reach something drawable here is the wrong answer. Composed around
  // `findNextCompatibleQueueItem` rather than folded into it, because that
  // helper also answers the BLE senders' question — "can this wall physically
  // draw it" — where reachability is meaningless.
  const reachableIndex = items.findIndex(({ climb }) => climb != null && isReachable(climb));
  if (reachableIndex < 0) return { item, skippedItems: items.slice(0, skippedCount), atTrackEnd: false };

  const compatibleIndex = item ? items.findIndex(({ uuid }) => uuid === item.uuid) : -1;
  if (compatibleIndex >= 0 && compatibleIndex <= reachableIndex) {
    return { item, skippedItems: items.slice(0, skippedCount), atTrackEnd: false };
  }
  return { item: items[reachableIndex], skippedItems: items.slice(0, reachableIndex), atTrackEnd: false };
}

/**
 * Next-climb target for a play-drawer swipe, Next, the rest timer and every
 * other forward step.
 *
 * While the player walks a list (issue #4829: the climb was opened from search
 * results, a playlist, the logbook and so on), Next plays Up next first: the
 * queue after the current climb, in queue order, so Play next climbs come
 * before Play last ones (issue #6777, reversing the list-first rule of #6664).
 * Once Up next is played, the list picks up at the climb after the last list
 * climb played, the track's `resume`. Three cases for a current item that IS in
 * the queue, on a list or in Up next between two of its climbs:
 *
 *  1. Something is Up next → that queue item. Leaving the list for it reports
 *     `trackResume` (the list climb left from), so the caller can store where
 *     the list picks up again. An Up next climb that IS the list's next climb
 *     (a playlist loaded into the queue in order, Play next on the next list
 *     climb) is the list carrying on, and reports `trackResume: null`.
 *  2. Up next is played → the list successor of the list climb the walk is at,
 *     as a transient "peek" (or the real queue entry already holding it, see
 *     the symmetric dedupe below). On commit the peek is inserted even if that
 *     climb already appears elsewhere in the queue, so re-activating a playlist
 *     climb starts a fresh pass (the queue grows 1..10, 1..10).
 *  3. Up next is played and the list has ended → nothing, with `atTrackEnd`
 *     set (issue #6664): the player shows its end card, so the end card only
 *     comes up once both the list and Up next are done.
 *
 * Up next leaves out the climbs the list walk put in the queue itself (a list
 * tap or a committed swipe on this list, see {@link isListWalkEntry}): swiping
 * back down a list commits each climb after the current one, and those are the
 * list, never queued on purpose.
 *
 * A current climb off the list with no walk in Up next walks the queue, as it
 * always did. The queue is cross-board and holds leftovers from other lists,
 * which is why a list once walked only the list; the active board still skips
 * climbs this wall can't draw in Up next as it does anywhere in the queue. A
 * step that lands on the list never reports those as skipped: the track leaves
 * them out on its own.
 *
 * Symmetric dedupe: if the list target is ALREADY the queue item immediately
 * before or after current, return that real item instead of minting a peek, so
 * swiping back and forth doesn't append duplicates. Both sides matter because
 * the server always inserts after the current item and mobile verifies the
 * ORDERED queue hash: committing a *previous* peek yields `[…, W1, W0]` with W0
 * current, so the following "next" finds its list target W1 at
 * `currentIndex - 1`, not `+ 1`. With `activeConfig`, the search also walks on
 * past queued climbs the board can't draw, which the provider's board filter
 * took off the track: see {@link findQueuedListNeighbour}.
 *
 * An orphan current (not in the queue at all — the wrong-board view-only
 * preview, a crew browse, or transiently between a peek commit and the server
 * echo) walks only its list: a preview never plays Up next, since a look must
 * not use up anybody's queue. At the list's last climb it reports `atTrackEnd`
 * like a queued one. Off the list it has nothing to walk. It never falls back
 * to `queue[0]`, and it never dedupes (there is no meaningful adjacency).
 *
 * `activeConfig` makes the QUEUE walk board-aware (issue #5099): a swipe walks
 * past queued climbs the board on the wall cannot draw rather than handing back
 * a climb that renders nothing and lights nothing. Skipped climbs stay in the
 * queue and stay reachable from the queue sheet — they just stop being swipe
 * targets. Identity-only (`classifyClimbBoardCompatibility`), so a same-layout
 * different-size climb is never skipped: those still render, on their own board.
 * Omit `activeConfig`, or leave a climb without board metadata, and nothing is
 * skipped — this fails open by design.
 *
 * `isReachable` re-opens that skip for the climbs it should never have covered.
 * At a gym with more than one wall a climber deliberately queues from both, and
 * skipping past the Tension climbs because they are standing at the Kilter
 * silently deletes half their session. A climb on a wall in the same room is a
 * navigation target: the drawer offers to move them to it. A climb on a board in
 * another city stays skipped, which is what #5099 was actually about.
 *
 * The LIST step is deliberately left board-blind: the play drawer feeds it a
 * source that is sometimes bound to another board on purpose (the wrong-board
 * view-only preview). Staleness of the provider's own source is handled where
 * that source lives, not here.
 */
export function selectNextQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
  prepared?: PreparedQueueNavigation,
): NextQueueItemSelection {
  if (currentClimbQueueItem) {
    const currentIndex = findCurrentQueueIndex(queue, currentClimbQueueItem, prepared);
    const position = resolveTrackPosition(queue, currentClimbQueueItem, source, prepared);
    if (source && position.kind !== 'off') {
      if (currentIndex >= 0) {
        return selectNextOnTrack(
          queue,
          currentClimbQueueItem,
          currentIndex,
          source,
          position,
          activeConfig,
          isReachable,
        );
      }
      // A preview walks its list and nothing else.
      const listSuccessor = position.kind === 'list' ? source.climbs[position.trackIndex + 1] : undefined;
      return listSuccessor ? { item: toPeekItem(listSuccessor), skippedItems: [], atTrackEnd: false } : TRACK_END;
    }
    // No list, or off it: a queued climb walks the queue, with board filtering;
    // an orphan has nothing to walk.
    return currentIndex >= 0
      ? scanForFirstCompatible(queue.slice(currentIndex + 1), activeConfig, isReachable)
      : NOTHING_NEXT;
  }

  if (queue.length > 0) {
    const scanned = scanForFirstCompatible(queue, activeConfig, isReachable);
    if (scanned.item) return scanned;
    const firstSuggestionAfterQueue = getPlaylistSuggestedClimbs(source, queue)[0];
    return {
      item: firstSuggestionAfterQueue ? toPeekItem(firstSuggestionAfterQueue) : null,
      skippedItems: scanned.skippedItems,
      atTrackEnd: false,
    };
  }

  // No current climb and an empty queue: seed from the activated climb's first
  // suggestion (getPlaylistSuggestedClimbs anchors on source.activatedClimbUuid).
  const firstSuggestion = getPlaylistSuggestedClimbs(source, queue)[0];
  return firstSuggestion ? { item: toPeekItem(firstSuggestion), skippedItems: [], atTrackEnd: false } : NOTHING_NEXT;
}

/**
 * The forward step for a queued climb on a list, or in Up next between two of
 * its climbs: Up next first, then the list after the list climb the walk is
 * at. See {@link selectNextQueueItemWithSuggestions}.
 */
function selectNextOnTrack(
  queue: ClimbQueue,
  currentItem: ClimbQueueItem,
  currentIndex: number,
  source: PlaylistSuggestionSource,
  position: Exclude<TrackPosition, { kind: 'off' }>,
  activeConfig: ActiveBoardForCompatibility | undefined,
  isReachable: ReachableClimbPredicate | undefined,
): NextQueueItemSelection {
  const listIndex = position.kind === 'list' ? position.trackIndex : position.resumeIndex;
  const listSuccessor: Climb | undefined = source.climbs[listIndex + 1];
  const upNext = scanForFirstCompatible(upNextQueueItems(queue, currentIndex, source), activeConfig, isReachable);
  if (upNext.item) {
    // Up next and the list agree on what comes next: the list carries on, and
    // anything walked past on the way is a climb the track left out too.
    if (listSuccessor && upNext.item.climb?.uuid === listSuccessor.uuid) {
      return { item: upNext.item, skippedItems: [], atTrackEnd: false, trackResume: null };
    }
    const trackResume =
      position.kind === 'list' ? { climbUuid: currentItem.climb.uuid, queueItemUuid: currentItem.uuid } : undefined;
    return { item: upNext.item, skippedItems: upNext.skippedItems, atTrackEnd: false, trackResume };
  }
  // Up next is played (or holds nothing this wall can draw: those stay queued,
  // and the end card counts them). The list picks up again. Coming out of Up
  // next, only an entry ahead of the current climb carries the list on.
  if (!listSuccessor) return TRACK_END;
  const queuedItem = findQueuedListNeighbour(
    queue,
    currentIndex,
    listSuccessor.uuid,
    1,
    activeConfig,
    isReachable,
    position.kind === 'upNext',
  );
  return { item: queuedItem ?? toPeekItem(listSuccessor), skippedItems: [], atTrackEnd: false, trackResume: null };
}

/** `selectNextQueueItemWithSuggestions` for callers that don't report skips. */
export function findNextQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
  prepared?: PreparedQueueNavigation,
): ClimbQueueItem | null {
  return selectNextQueueItemWithSuggestions(queue, currentClimbQueueItem, source, activeConfig, isReachable, prepared)
    .item;
}

/** What a backward step resolved to. See {@link NextQueueItemSelection.trackResume} for `trackResume`. */
export type PreviousQueueItemSelection = {
  item: ClimbQueueItem | null;
  trackResume?: PlaylistTrackResume | null;
};

const NOTHING_PREVIOUS: PreviousQueueItemSelection = { item: null };

/**
 * Previous-climb target for a play-drawer swipe — the mirror of
 * selectNextQueueItemWithSuggestions. Previous retraces the climber's steps
 * (issue #6777):
 *
 *  1. Playing Up next → the queue entry before it, which is where the walk came
 *     from: the previous Up next climb, or, from the first one, the list climb
 *     it left (back on the list: `trackResume: null`). List-walk entries and
 *     climbs this wall can't draw are passed over, since Next never played them.
 *     When the list climb's entry is gone from the queue (a crewmate removed
 *     it), there is no telling Up next from History behind the current climb,
 *     so Previous goes straight back to that list climb, as a peek, rather
 *     than walking into climbs from before the list.
 *  2. On the list, right after a stretch of Up next → the last of those Up
 *     next climbs, with `trackResume` naming the list entry before them. The
 *     track's `detour` says which stretch the walk came back from, and where
 *     it left the list, so Previous retraces it exactly (see
 *     {@link retraceDetour}). Without one, History has to show it: the list's
 *     previous climb, or an older list-walk entry of this same climb, then Up
 *     next climbs, then this one (see {@link findUpNextBehind}).
 *  3. Otherwise on the list → the list predecessor, as a transient "peek" (or
 *     the adjacent real queue item — see the symmetric dedupe note on
 *     selectNextQueueItemWithSuggestions). The list's start is a stop, like its
 *     end (issue #6664): falling back into History here walked the climber into
 *     climbs from before the list with nothing to say so.
 *  4. No source, or off the list → the queue predecessor.
 *
 * An orphan current (not in the queue — the wrong-board view-only preview,
 * whose peeked climbs are never committed) peeks the list predecessor if the
 * climb is in the source, else null.
 *
 * `activeConfig` and `isReachable` steer which queue entry stands for the
 * list predecessor (see {@link findQueuedListNeighbour}) and which Up next
 * climbs were walked past; the plain queue walk stays board-blind going back,
 * as computeNavigationStateWithSuggestions explains.
 */
export function selectPreviousQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  prepared?: PreparedQueueNavigation,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
): PreviousQueueItemSelection {
  if (!currentClimbQueueItem) return NOTHING_PREVIOUS;

  const currentIndex = findCurrentQueueIndex(queue, currentClimbQueueItem, prepared);
  const position = resolveTrackPosition(queue, currentClimbQueueItem, source, prepared);
  if (source && position.kind === 'upNext') {
    if (findQueueIndexOfEntry(queue, position.resume.queueItemUuid, prepared) < 0) {
      const resumeClimb = source.climbs[position.resumeIndex];
      return resumeClimb ? { item: toPeekItem(resumeClimb), trackResume: null } : NOTHING_PREVIOUS;
    }
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const item = queue[index];
      if (item.uuid === position.resume.queueItemUuid) return { item, trackResume: null };
      if (isListWalkEntry(item, source) || swipeWalksPast(item, activeConfig, isReachable)) continue;
      return { item };
    }
    return NOTHING_PREVIOUS;
  }
  if (source && position.kind === 'list') {
    const listPredecessor = source.climbs[position.trackIndex - 1];
    if (!listPredecessor) return NOTHING_PREVIOUS;
    const detour = retraceDetour(queue, currentIndex, source, position.trackIndex, activeConfig, isReachable);
    if (detour) return detour;
    const upNextBehind = findUpNextBehind(
      queue,
      currentIndex,
      source,
      currentClimbQueueItem.climb.uuid,
      listPredecessor.uuid,
      activeConfig,
      isReachable,
    );
    if (upNextBehind) return upNextBehind;
    const queuedItem = findQueuedListNeighbour(
      queue,
      currentIndex,
      listPredecessor.uuid,
      -1,
      activeConfig,
      isReachable,
    );
    return { item: queuedItem ?? toPeekItem(listPredecessor), trackResume: null };
  }
  // No list, or off it: a queued climb walks the queue; an orphan has nothing.
  return { item: currentIndex > 0 ? queue[currentIndex - 1] : null };
}

/**
 * The Up next stretch the walk last came back to the list from, retraced from
 * the track's `detour` (the resume it held while playing it), when the climb on
 * screen is the list climb that stretch handed back to: the one right after
 * the detour's list climb, with the stretch's queued climbs right behind it.
 *
 * Returns the last Up next climb played, with the detour as the resume point,
 * so the next Previous walks the rest of the stretch back to the list climb it
 * left. Between that list climb's entry and the stretch, Next walked past the
 * list's own entries (a swipe down the list and back commits them), so this
 * passes over them too: s1, s2, s3, back to s1, Play last X, then Next to X and
 * to a fresh s2 reads s1, s2, s3, X, s2' in the queue, and Previous goes
 * s2' -> X -> s1.
 *
 * Null when the track has no detour, when this is not the list climb it handed
 * back to, when a list-walk entry comes before any queued climb (the walk got
 * here along the list, not out of Up next), or when the entry the detour left
 * from is gone from the queue; Previous then reads History as before.
 */
function retraceDetour(
  queue: ClimbQueue,
  currentIndex: number,
  source: PlaylistSuggestionSource,
  trackIndex: number,
  activeConfig: ActiveBoardForCompatibility | undefined,
  isReachable: ReachableClimbPredicate | undefined,
): PreviousQueueItemSelection | null {
  const { detour } = source;
  if (!detour || trackIndexOf(source, detour.climbUuid) !== trackIndex - 1) return null;
  let lastPlayed: ClimbQueueItem | null = null;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (item.uuid === detour.queueItemUuid) return lastPlayed ? { item: lastPlayed, trackResume: detour } : null;
    if (isListWalkEntry(item, source)) {
      if (!lastPlayed) return null;
      continue;
    }
    if (!lastPlayed && !swipeWalksPast(item, activeConfig, isReachable)) lastPlayed = item;
  }
  return null;
}

/**
 * The Up next stretch right behind a list climb, if History has one: walking
 * back from `currentIndex`, queued climbs Next would have played, then the
 * queue entry of the list's previous climb. Returns the last of those climbs,
 * and the list climb before them as the resume point, so Previous retraces the
 * queue before going back up the list. Null when the entry right behind is the
 * list's previous climb itself, when a list-walk entry of another place on the
 * list comes first, or when History never reaches the list's previous climb
 * (climbs from before the list was tapped).
 *
 * The stretch can also end at an older list-walk entry of the current climb
 * itself: swipe from s1 to s2, back to s1, add X, then Next plays X and picks
 * the list up with a fresh s2 entry, so the queue reads s1, s2, X, s2. That
 * older s2 is the list climb before the detour. Previous goes to X, and from X
 * back onto that older entry, then up the list to s1. The resume point keeps
 * the list's previous climb (s1) as where the list picks up, so Next from X
 * still lands back on the newer s2, and names the older entry as the one the
 * walk left from.
 */
function findUpNextBehind(
  queue: ClimbQueue,
  currentIndex: number,
  source: PlaylistSuggestionSource,
  currentClimbUuid: string,
  listPredecessorUuid: string,
  activeConfig: ActiveBoardForCompatibility | undefined,
  isReachable: ReachableClimbPredicate | undefined,
): PreviousQueueItemSelection | null {
  let lastPlayed: ClimbQueueItem | null = null;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const item = queue[index];
    const climbUuid = item.climb?.uuid;
    const endsStretch =
      climbUuid === listPredecessorUuid || (climbUuid === currentClimbUuid && isListWalkEntry(item, source));
    if (endsStretch) {
      return lastPlayed
        ? { item: lastPlayed, trackResume: { climbUuid: listPredecessorUuid, queueItemUuid: item.uuid } }
        : null;
    }
    if (isListWalkEntry(item, source)) return null;
    if (!lastPlayed && !swipeWalksPast(item, activeConfig, isReachable)) lastPlayed = item;
  }
  return null;
}

/**
 * What the track's `resume` becomes when a queue entry reached outside the walk
 * goes up on the wall (issue #6777): with Light on swipe off, or in a crew, a
 * swipe off the committed climb is a look that walks the queue, and Put on the
 * wall commits the queued climb it landed on.
 *
 * An entry ahead of the current climb that the walk would play as Up next goes
 * up the way Next steps into it: the list climb the walk is at (the current
 * one, or the one it already left from) is where the list picks up. An entry
 * that carries the list on (a queued copy of the list's next climb, or one the
 * list walk itself put there) returns null: it is on the list. Anything else
 * (no track, a list with nothing left, History, the current climb itself)
 * returns undefined: the track stops steering, as it did before.
 */
export function resolveUpNextCommitResume(
  queue: ClimbQueue,
  currentItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  targetItem: ClimbQueueItem,
  prepared?: PreparedQueueNavigation,
): PlaylistTrackResume | null | undefined {
  if (!source || !currentItem) return undefined;
  const position = resolveTrackPosition(queue, currentItem, source, prepared);
  if (position.kind === 'off') return undefined;
  const currentIndex = findCurrentQueueIndex(queue, currentItem, prepared);
  if (currentIndex < 0 || findQueueIndexOfEntry(queue, targetItem.uuid, prepared) <= currentIndex) return undefined;
  const listIndex = position.kind === 'list' ? position.trackIndex : position.resumeIndex;
  const listSuccessorUuid = source.climbs[listIndex + 1]?.uuid;
  // A finished list has no place to keep: the end card's "Keep going with your
  // queue" leaves it behind, previewed or not.
  if (!listSuccessorUuid) return undefined;
  if (targetItem.climb?.uuid === listSuccessorUuid || isListWalkEntry(targetItem, source)) return null;
  return position.kind === 'list'
    ? { climbUuid: currentItem.climb.uuid, queueItemUuid: currentItem.uuid }
    : position.resume;
}

/** `selectPreviousQueueItemWithSuggestions` for callers that only need the climb. */
export function findPreviousQueueItemWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  prepared?: PreparedQueueNavigation,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
): ClimbQueueItem | null {
  return selectPreviousQueueItemWithSuggestions(
    queue,
    currentClimbQueueItem,
    source,
    prepared,
    activeConfig,
    isReachable,
  ).item;
}

/**
 * Ceiling on the forward walk behind `remainingCount`. The action bar shows a
 * small number and a climber never reads past a couple of dozen, so counting
 * every reachable climb in a long queue would cost a full walk to tell two
 * indistinguishable answers apart.
 */
const REMAINING_COUNT_CAP = 99;

/**
 * Which suggestion source, if any, steers next/prev for what is on screen.
 *
 * A source belongs to exactly one lineage. The provider's source describes the
 * COMMITTED climb's track. A pinned PREVIEW is a different lineage: it navigates
 * the track it was opened with, or no track at all. A preview never borrows,
 * inherits, or captures the committed track — issue #5403, where a list tap that
 * opened as a source-less preview inherited the track from an earlier activation
 * on a different list, and swiping walked climbs the climber had filtered out.
 *
 * The committed track is usable only while it still anchors the committed climb,
 * or while the walk plays Up next in the middle of it (its `resume`).
 * That predicate lives here, evaluated during render at the point of use, rather
 * than in an effect beside whoever wrote the current climb: roughly eight call
 * sites write it without going through the activation helper, and an effect
 * leaves one render in which navigation is computed against the old track.
 */
export function resolveNavigationSuggestionSource({
  previewItem,
  previewSource,
  committedItem,
  committedSource,
}: {
  previewItem: ClimbQueueItem | null;
  previewSource: PlaylistSuggestionSource | null;
  committedItem: ClimbQueueItem | null;
  committedSource: PlaylistSuggestionSource | null;
}): PlaylistSuggestionSource | null {
  if (previewItem) return previewSource;
  return anchoredSuggestionSource(committedSource, committedItem);
}

/**
 * The committed half of {@link resolveNavigationSuggestionSource}: a source is
 * only usable while its ordered list still contains the climb being navigated
 * from, or while the walk plays Up next in the middle of it (issue #6777: the
 * track's `resume` names a climb still on it). Otherwise next/prev fall back
 * to the queue.
 *
 * Exported so the queue provider can derive its own navigation source through
 * the same predicate instead of keeping a second copy of the rule — its
 * `nextClimb` / `previousClimb` read the source directly and never see the
 * drawer's resolver call.
 *
 * With nothing to navigate from — no item, or a still-thin peer climb with no
 * uuid — the source is kept: it outlives an empty queue, and forward navigation
 * seeds the first pass from it.
 */
export function anchoredSuggestionSource(
  source: PlaylistSuggestionSource | null,
  item: ClimbQueueItem | null,
): PlaylistSuggestionSource | null {
  const climbUuid = item?.climb?.uuid;
  if (!source || !climbUuid) return source;
  if (findPlaylistClimbIndex(source, climbUuid) >= 0) return source;
  // Playing Up next in the middle of the list (issue #6777): the climb is off
  // the list, and the list picks up again after it.
  return source.resume && findPlaylistClimbIndex(source, source.resume.climbUuid) >= 0 ? source : null;
}

/**
 * computeNavigationState over the track rules: while a list is walked,
 * canNext/nextItem come from Up next and then the list (issue #6777), and
 * canPrevious/prevItem retrace the walk; with no list they come from the queue.
 *
 * `remainingCount` counts the forward WALK, not the queue tail: it is the number
 * of climbs a climber could actually reach by swiping, capped at
 * {@link REMAINING_COUNT_CAP}. Counting the tail instead let the bar read "N
 * left" beside a dead Next button at the end of a list (issue #5403), which is
 * the opposite of what the number is for. It is also what makes the dead end
 * self-explanatory without a message: "0 left" beside a disabled Next says the
 * list ended, and the list ended where the climber's own filter says it does.
 *
 * `activeConfig` is forwarded to the forward scan and through the walk, so
 * `canNext`, the header peek and "N left" all agree with the climb a swipe
 * actually lands on. Backward navigation is deliberately
 * left alone: swiping back should return you where you came from, and a
 * cross-board climb reached that way is drawn on its own board.
 *
 * That asymmetry used to have a sharp edge — forward skipped a climb backward
 * would still land on, so the two directions disagreed about the same queue.
 * `isReachable` removes it for the case that mattered: a climb on another wall
 * at this gym is now a forward target too, so both directions reach it. What
 * remains asymmetric is a genuinely far-away board, where "return me where I
 * came from" is still the right answer going back.
 */
/** Immediate next/previous targets without walking the remaining track. */
export function computeNavigationTargetsWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
  prepared?: PreparedQueueNavigation,
): Omit<NavigationState, 'remainingCount'> {
  const { item: nextItem, atTrackEnd } = selectNextQueueItemWithSuggestions(
    queue,
    currentClimbQueueItem,
    source,
    activeConfig,
    isReachable,
    prepared,
  );
  const prevItem = findPreviousQueueItemWithSuggestions(
    queue,
    currentClimbQueueItem,
    source,
    prepared,
    activeConfig,
    isReachable,
  );
  return { canNext: nextItem !== null, canPrevious: prevItem !== null, nextItem, prevItem, atTrackEnd };
}

export function countRemainingQueueItemsWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
  prepared?: PreparedQueueNavigation,
): number {
  return findUpcomingQueueItemsWithSuggestions(
    queue,
    currentClimbQueueItem,
    source,
    REMAINING_COUNT_CAP,
    activeConfig,
    isReachable,
    prepared,
  ).length;
}

export function computeNavigationStateWithSuggestions(
  queue: ClimbQueue,
  currentClimbQueueItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  activeConfig?: ActiveBoardForCompatibility,
  isReachable?: ReachableClimbPredicate,
  prepared?: PreparedQueueNavigation,
): NavigationState {
  return {
    ...computeNavigationTargetsWithSuggestions(
      queue,
      currentClimbQueueItem,
      source,
      activeConfig,
      isReachable,
      prepared,
    ),
    remainingCount: countRemainingQueueItemsWithSuggestions(
      queue,
      currentClimbQueueItem,
      source,
      activeConfig,
      isReachable,
      prepared,
    ),
  };
}

/**
 * The next `count` swipe targets after `currentClimbQueueItem`, in the order a
 * climber would reach them — the same walk `selectNextQueueItemWithSuggestions`
 * does for one step, repeated with each result as the next step's current item
 * and its `trackResume` stored on the track, as committing the step would.
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
  isReachable?: ReachableClimbPredicate,
  prepared?: PreparedQueueNavigation,
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
  // Each step leaves the track where a committed step would (into Up next and
  // back to the list), so the walk visits Up next and then the list, in order.
  let walkSource = source;
  let stepsLeft = count + queue.length;
  while (upcomingItems.length < count && stepsLeft > 0) {
    stepsLeft -= 1;
    const { item: nextItem, trackResume } = selectNextQueueItemWithSuggestions(
      queue,
      walkFrom,
      walkSource,
      activeConfig,
      isReachable,
      prepared,
    );
    if (!nextItem) break;
    if (seenItemUuids.has(nextItem.uuid)) break;
    seenItemUuids.add(nextItem.uuid);
    walkFrom = nextItem;
    if (walkSource && trackResume !== undefined) walkSource = withPlaylistTrackResume(walkSource, trackResume);
    const nextClimbUuid = nextItem.climb?.uuid;
    if (nextClimbUuid !== undefined && seenClimbUuids.has(nextClimbUuid)) continue;
    if (nextClimbUuid) seenClimbUuids.add(nextClimbUuid);
    upcomingItems.push(nextItem);
  }

  return upcomingItems;
}
