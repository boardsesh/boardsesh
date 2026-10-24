import type { ClimbQueueItem } from '@boardsesh/queue';
import type { NavigationState, TrackLabelModel } from '@boardsesh/play-view';

/**
 * What the end card's one action does (issue #6664). It always leaves the list:
 *
 * - `nextInQueue`: the climb on screen is the committed one, so the climber
 *   carries on with what is queued after it. `target` is that climb.
 * - `backToCommitted`: the climb on screen is a preview (wrong board, a crew
 *   tap), which is not in the queue, so "your queue" starts back at its Now.
 */
export type TrackEndAction = { kind: 'nextInQueue'; target: ClimbQueueItem } | { kind: 'backToCommitted' };

export type TrackEndCardModel = {
  /** The list that ended, as the header named it; null for a list nobody named. */
  listName: string | null;
  /** How many climbs are Up next after the queue's Now. */
  upNextCount: number;
  /**
   * The climb "Keep going" opens, named on the card so the climber knows what
   * comes after the list (#6238). Capped at {@link MAX_FIRST_UP_NEXT_NAME_LENGTH}.
   * Null when the action goes back to Now instead (a preview), or the climb has
   * no name: the card then reads as it did before.
   */
  firstUpNextName: string | null;
  /** Null when nothing is queued after Now: the card then only says the list is finished. */
  action: TrackEndAction | null;
};

/** Room for "Crimp Ladder" and most setter names; a pasted paragraph gets an ellipsis. */
export const MAX_FIRST_UP_NEXT_NAME_LENGTH = 32;
const ELLIPSIS = '\u2026';

/**
 * How many climbs are Up next: everything queued after the queue's Now
 * (`committedQueueIndex`, -1 without one). The end card's number and the queue
 * button's badge both read this, so they always agree.
 */
export function countUpNext(queueLength: number, committedQueueIndex: number): number {
  return committedQueueIndex >= 0 ? Math.max(0, queueLength - committedQueueIndex - 1) : 0;
}

/**
 * The queue button's badge while the player walks a list (#6238): Up next is
 * not what Next plays then, so the badge keeps it in sight. Zero, so no badge,
 * whenever the header names no list.
 */
export function resolveListWalkUpNextBadge(trackLabel: TrackLabelModel, upNextCount: number): number {
  return trackLabel.kind === 'hidden' ? 0 : upNextCount;
}

/** A climb name short enough for one line of the end card, cut on whole characters. */
export function truncateClimbName(name: string, maxLength = MAX_FIRST_UP_NEXT_NAME_LENGTH): string {
  const characters = Array.from(name.trim());
  if (characters.length <= maxLength) return characters.join('');
  return `${characters
    .slice(0, maxLength - 1)
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}

function firstUpNextNameOf(target: ClimbQueueItem): string | null {
  const name = truncateClimbName(target.climb.name ?? '');
  return name.length > 0 ? name : null;
}

/**
 * The end card for the climb on screen, or null when there is no end to show.
 *
 * Only the end of a list the player is walking gets one (`atTrackEnd`), and not
 * while more of it is still on its way: a track that pages in more climbs ends
 * where the list ends, not where the first load stopped.
 *
 * `committedQueueIndex` is where the queue's Now sits (-1 without one); the
 * caller already has the queue indexed. `queueSuccessor` is where a forward
 * walk of the queue lands from Now, board rules included, so the card goes
 * where Next would have gone before the list took over the swipe. When that
 * walk finds nothing the queue can draw, the card still offers the next queued
 * climb, which then opens on its own board: the number on the button counts it.
 */
export function resolveTrackEndCard({
  navigationState,
  moreToLoad,
  trackLabel,
  queue,
  committedQueueIndex,
  queueSuccessor,
  previewPinned,
}: {
  navigationState: Pick<NavigationState, 'atTrackEnd'>;
  moreToLoad: boolean;
  trackLabel: TrackLabelModel;
  queue: readonly ClimbQueueItem[];
  committedQueueIndex: number;
  queueSuccessor: ClimbQueueItem | null;
  previewPinned: boolean;
}): TrackEndCardModel | null {
  if (!navigationState.atTrackEnd || moreToLoad) return null;
  const listName = trackLabel.kind === 'hidden' ? null : trackLabel.name;
  const upNextCount = countUpNext(queue.length, committedQueueIndex);
  if (upNextCount <= 0) return { listName, upNextCount: 0, firstUpNextName: null, action: null };
  // A preview's action goes back to Now, which is not Up next: no name to promise.
  if (previewPinned) return { listName, upNextCount, firstUpNextName: null, action: { kind: 'backToCommitted' } };
  const target = queueSuccessor ?? queue[committedQueueIndex + 1];
  if (!target) return { listName, upNextCount, firstUpNextName: null, action: null };
  return { listName, upNextCount, firstUpNextName: firstUpNextNameOf(target), action: { kind: 'nextInQueue', target } };
}
