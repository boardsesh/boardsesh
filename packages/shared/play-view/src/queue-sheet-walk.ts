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
  /** F3 now-slot mode: the History / Up next line while nothing is current. */
  historyCount?: number | null;
};

/**
 * Walk forward from `from` along `source` exactly as successive swipes do, and
 * return every climb reached, in order.
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
 * climb reached twice is listed twice: the second visit is a swipe too. The
 * walk ends at the first queue entry or peek it has already reached (a peek's
 * uuid comes from its climb, so a list that loops would otherwise walk
 * forever), and after `queue.length + track length + 1` steps at most.
 */
function walkForward(
  queue: ClimbQueue,
  from: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
  prepared: PreparedQueueNavigation,
  { activeConfig, isReachable, historyCount }: QueueWalkOptions,
): ClimbQueueItem[] {
  const walked: ClimbQueueItem[] = [];
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
    if (!item || reached.has(item.uuid)) return walked;
    reached.add(item.uuid);
    if (walkSource && trackResume !== undefined) {
      walkSource = withPlaylistTrackResume(walkSource, trackResume, walkFrom?.uuid);
    }
    walkFrom = item;
    walked.push(item);
  }
  return walked;
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
  const prepared = prepareQueueNavigation(queue);
  const line = upNextStart(queue, currentItem, options.historyCount);
  return walkForward(queue, currentItem, source, prepared, options).filter((item) => {
    const queueIndex = prepared.firstIndexByUuid.get(item.uuid);
    return queueIndex === undefined || queueIndex < line;
  });
}
