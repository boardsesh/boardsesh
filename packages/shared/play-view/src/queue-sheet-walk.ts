import {
  upNextStart,
  withPlaylistTrackResume,
  type ClimbQueue,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
} from '@boardsesh/queue';
import type { ActiveBoardForCompatibility } from '@boardsesh/board-config';
import {
  prepareQueueNavigation,
  selectNextQueueItemWithSuggestions,
  type PreparedQueueNavigation,
  type ReachableClimbPredicate,
} from './queue-navigation';

/**
 * The board a forward walk is filtered against: the same two inputs the queue
 * provider's `nextClimb` and the player pass to
 * {@link selectNextQueueItemWithSuggestions}. Omit both and the walk is
 * board-blind, which only changes which queued climbs it walks past.
 */
export type QueueWalkBoard = {
  activeConfig?: ActiveBoardForCompatibility;
  isReachable?: ReachableClimbPredicate;
};

type QueueWalkOptions = QueueWalkBoard & {
  prepared?: PreparedQueueNavigation;
  /** F3 now-slot mode: the History / Up next line while nothing is current. */
  historyCount?: number | null;
};

/** `prepared` when it indexes this queue, otherwise a fresh index. */
function preparedFor(queue: ClimbQueue, prepared: PreparedQueueNavigation | undefined): PreparedQueueNavigation {
  return prepared?.queue === queue ? prepared : prepareQueueNavigation(queue);
}

/**
 * Walk forward from `from` along `source` exactly as successive swipes do, and
 * hand each climb reached to `visit` until it returns false or the walk ends.
 *
 * One step is {@link selectNextQueueItemWithSuggestions}, the selection the
 * player's swipe, Next, the MiniPlayer's ⏭ and the provider's `nextClimb` all
 * make. Between steps the track keeps the step's `trackResume`, as a look's
 * step does (`resolvePreviewStepSource`) and as committing it does
 * (`storeTrackResume`), so the walk plays Up next and then picks the list up
 * where it left off. Nothing is committed: a list climb is reached as the
 * transient peek a swipe would mint.
 *
 * Unlike `findUpcomingQueueItemsWithSuggestions` (the render prefetch), a
 * climb reached twice is visited twice: the second visit is a swipe too. The
 * walk ends at the first queue entry or peek it has already reached (a peek's
 * uuid comes from its climb, so a list that loops would otherwise walk
 * forever), and after `queue.length + track length + 1` steps at most.
 */
function walkForward(
  queue: ClimbQueue,
  from: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  { activeConfig, isReachable, prepared, historyCount }: QueueWalkOptions,
  visit: (item: ClimbQueueItem) => boolean,
): void {
  const reached = new Set<string>();
  if (from) reached.add(from.uuid);
  let walkFrom = from;
  let walkSource = source;
  let stepsLeft = queue.length + (source?.climbs.length ?? 0) + 1;
  while (stepsLeft > 0) {
    stepsLeft -= 1;
    const { item, trackResume } = selectNextQueueItemWithSuggestions(
      queue,
      walkFrom,
      walkSource,
      activeConfig,
      isReachable,
      prepared,
      historyCount,
    );
    if (!item || reached.has(item.uuid)) return;
    reached.add(item.uuid);
    if (walkSource && trackResume !== undefined) {
      walkSource = withPlaylistTrackResume(walkSource, trackResume, walkFrom?.uuid);
    }
    walkFrom = item;
    if (!visit(item)) return;
  }
}

/**
 * The queue sheet's "Then from Projects" (Then-signposts, 2026-11-02): the
 * climbs swipes from the queue's current climb reach after Up next, in the
 * order they reach them.
 *
 * It is the walk ({@link walkForward}) from `currentItem` along `source`, the
 * track the queue holds for it (`usePlaylistSuggestionSource`, the one the
 * player's top bar names), with every climb the sheet already lists under Now
 * or Up next left out: those are queue entries from the History / Up next line
 * on. What is left is the list part of the walk, mostly peeks of the list's
 * climbs. A list climb the queue's History still holds is listed too when a
 * swipe goes there, because it does: the list does not skip a climb for having
 * been climbed before.
 *
 * Empty with no track: the walk then never leaves the queue.
 */
export function resolveThenFromListItems(
  queue: ClimbQueue,
  currentItem: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  options: QueueWalkOptions = {},
): ClimbQueueItem[] {
  if (!source) return [];
  const prepared = preparedFor(queue, options.prepared);
  const line = upNextStart(queue, currentItem, options.historyCount);
  const thenFrom: ClimbQueueItem[] = [];
  walkForward(queue, currentItem, source, { ...options, prepared }, (item) => {
    const queueIndex = prepared.firstIndexByUuid.get(item.uuid);
    if (queueIndex === undefined || queueIndex < line) thenFrom.push(item);
    return true;
  });
  return thenFrom;
}

/**
 * Whether the queue's Up next is waiting while the climber looks elsewhere:
 * Up next holds climbs, and swipes from the climb the player shows
 * (`shownItem`, walking `shownSource`) never reach any of them. Up next is the
 * climbs after `currentItem`, or from the History / Up next line on with
 * nothing current.
 *
 * True reads "Up next: 4 waiting" on a preview and "4 climbs · waiting" on the
 * queue sheet. A preview opened from a list walks only that list (#7227), so
 * Up next waits however far it goes; so does a preview with no list, whose
 * swipes go nowhere. A queue slot walks the queue, so it reaches Up next, and
 * a slot in Up next is already there.
 *
 * False with nothing shown, and with Up next empty: nothing is waiting.
 */
export function isUpNextWaiting(
  queue: ClimbQueue,
  shownItem: ClimbQueueItem | null,
  shownSource: PlaylistSuggestionSource | null,
  {
    currentItem,
    ...options
  }: QueueWalkOptions & {
    /** The queue's current climb: Up next is what comes after it. */
    currentItem: ClimbQueueItem | null;
  },
): boolean {
  const line = upNextStart(queue, currentItem, options.historyCount);
  if (!shownItem || line >= queue.length) return false;
  const prepared = preparedFor(queue, options.prepared);
  const inUpNext = (item: ClimbQueueItem) => (prepared.firstIndexByUuid.get(item.uuid) ?? -1) >= line;
  if (inUpNext(shownItem)) return false;
  let reachesUpNext = false;
  walkForward(queue, shownItem, shownSource, { ...options, prepared }, (item) => {
    if (inUpNext(item)) {
      reachesUpNext = true;
      return false;
    }
    // A step from a climb outside the queue only ever lands on its list's next
    // peek (selectNextQueueItemWithSuggestions' orphan rule), so once the walk
    // is off the queue it never comes back: stop rather than walk the list.
    return prepared.firstIndexByUuid.has(item.uuid);
  });
  return !reachesUpNext;
}
