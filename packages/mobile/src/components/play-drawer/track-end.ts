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
  /** Null when nothing is queued after Now: the card then only says the list is finished. */
  action: TrackEndAction | null;
};

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
  const upNextCount = committedQueueIndex >= 0 ? queue.length - committedQueueIndex - 1 : 0;
  if (upNextCount <= 0) return { listName, upNextCount: 0, action: null };
  if (previewPinned) return { listName, upNextCount, action: { kind: 'backToCommitted' } };
  const target = queueSuccessor ?? queue[committedQueueIndex + 1];
  return { listName, upNextCount, action: target ? { kind: 'nextInQueue', target } : null };
}
