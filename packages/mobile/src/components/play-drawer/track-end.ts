import type { ClimbQueueItem } from '@boardsesh/queue';
import { trackLabelListName, type NavigationState, type TrackLabelModel } from '@boardsesh/play-view';

/**
 * What the end card's one action does (issue #6664). It always leaves the list:
 *
 * - `nextInQueue`: the climb on screen is the committed one, so the climber
 *   carries on with what is queued after it. `target` is that climb.
 * - `backToCommitted`: the climb on screen is a preview (wrong board, a crew
 *   tap), which is not in the queue, so "your queue" starts back at its Now.
 *   Only while there is a Now: a preview over a queue with none carries on
 *   with `nextInQueue` instead.
 */
export type TrackEndAction = { kind: 'nextInQueue'; target: ClimbQueueItem } | { kind: 'backToCommitted' };

export type TrackEndCardModel = {
  /** The list that ended, as the header named it; null for a list nobody named. */
  listName: string | null;
  /** How many climbs are Up next: after the queue's Now, or the whole queue without one. */
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
 * (`committedQueueIndex`), or the whole queue when Now is not in it (-1). The
 * end card's number, the queue button's badge and the queue sheet's "Up next"
 * header all count this way, so they always agree.
 */
export function countUpNext(queueLength: number, committedQueueIndex: number): number {
  return Math.max(0, queueLength - committedQueueIndex - 1);
}

/**
 * The queue button's Up next count while the player walks a list (#6238): Next
 * plays Up next before the list goes on (#6777), so the button says how much
 * of it is coming. Null
 * whenever the header names no list: the button then counts what a swipe
 * reaches, as it always has. Zero is a walked list with nothing Up next: no
 * badge, but the button still speaks Up next.
 */
export function resolveListWalkUpNextBadge(trackLabel: TrackLabelModel, upNextCount: number): number | null {
  return trackLabel.kind === 'hidden' ? null : upNextCount;
}

/**
 * A climb name short enough for one line of the end card, cut between whole
 * code points, so a surrogate pair is never split. A multi-code-point emoji (a
 * flag, a skin tone, a ZWJ family) or a letter with a combining accent that
 * straddles the cut can still lose its tail: Hermes has no `Intl.Segmenter`
 * to cut on grapheme clusters, and climb names that long rarely carry them.
 */
export function truncateClimbName(name: string, maxLength = MAX_FIRST_UP_NEXT_NAME_LENGTH): string {
  const characters = Array.from(name.trim());
  if (characters.length <= maxLength) return characters.join('');
  return `${characters
    .slice(0, maxLength - 1)
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}

function firstUpNextNameOf(target: ClimbQueueItem): string | null {
  // The wire boundary is untyped: a peer's item can land before its climb does.
  const name = truncateClimbName(target.climb?.name ?? '');
  return name.length > 0 ? name : null;
}

/**
 * The end card for the climb on screen, or null when there is no end to show.
 *
 * Only the end of a list the player is walking gets one (`atTrackEnd`), and not
 * while more of it is still on its way: a track that pages in more climbs ends
 * where the list ends, not where the first load stopped. Next plays Up next
 * before the list goes on (#6777), so `atTrackEnd` only comes once both are
 * done; anything still queued after Now then is what the walk passed over (a
 * climb this wall can't draw), and the card's action offers it.
 *
 * `committedQueueIndex` is where the queue's Now sits (-1 when Now is not in
 * the queue); the caller already has the queue indexed. `queueSuccessor` is
 * where a forward walk of the queue lands from Now (from the top without one),
 * board rules included, so the card goes where Next would have gone before the
 * list took over the swipe. When that walk finds nothing the queue can draw,
 * the card still offers the next queued climb, which then opens on its own
 * board: the number on the button counts it.
 *
 * `previewOverNow` is a preview pinned while the queue has a Now: the action
 * goes back to that Now. A preview with no Now to go back to carries on into
 * the queue like a committed climb would.
 */
export function resolveTrackEndCard({
  navigationState,
  moreToLoad,
  trackLabel,
  queue,
  committedQueueIndex,
  queueSuccessor,
  previewOverNow,
}: {
  navigationState: Pick<NavigationState, 'atTrackEnd'>;
  moreToLoad: boolean;
  trackLabel: TrackLabelModel;
  queue: readonly ClimbQueueItem[];
  committedQueueIndex: number;
  queueSuccessor: ClimbQueueItem | null;
  previewOverNow: boolean;
}): TrackEndCardModel | null {
  if (!navigationState.atTrackEnd || moreToLoad) return null;
  // Up next can run out at the list's end too (#6777): the card still names the list.
  const listName = trackLabelListName(trackLabel);
  const upNextCount = countUpNext(queue.length, committedQueueIndex);
  if (upNextCount <= 0) return { listName, upNextCount: 0, firstUpNextName: null, action: null };
  // A preview's action goes back to Now, which is not Up next: no name to promise.
  if (previewOverNow) return { listName, upNextCount, firstUpNextName: null, action: { kind: 'backToCommitted' } };
  const target = queueSuccessor ?? queue[committedQueueIndex + 1];
  if (!target) return { listName, upNextCount, firstUpNextName: null, action: null };
  return { listName, upNextCount, firstUpNextName: firstUpNextNameOf(target), action: { kind: 'nextInQueue', target } };
}
