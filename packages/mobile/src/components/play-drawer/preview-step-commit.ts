import {
  reanchorPlaylistSuggestionSource,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
  type SetCurrentClimbOptions,
} from '@boardsesh/queue';
import type { QueueNavigationDirection } from '@boardsesh/analytics';
import { resolveCommittableQueueItem } from '../../lib/climb-to-queue-item';

/**
 * A step off a preview that goes up on the wall (a swipe that lights, or the
 * MiniPlayer's ⏮ ⏭ from the climber's last pick): which item goes up and how
 * the queue places it. One rule for the player and the bar, so the bar steps
 * exactly as a swipe in the player would.
 *
 * - A preview walking a list (#7113): the climb that walk steps to goes up
 *   (the list's next climb, or an Up next climb a look off the climb on the
 *   wall plays first, #7227), with the list as its track, re-anchored on it.
 *   `previewSuggestionSource` is the step's own source, carrying its place in
 *   Up next (`resolvePreviewStepSource`). The queue's own next would leave the
 *   list.
 * - A trackless preview with a neighbour of its own (a queue slot, a look
 *   walked along the queue): the neighbour goes up, keeping the walked track,
 *   as Put on board commits a look.
 *
 * Either way it is a step, placed as `nextClimb` places one: a fresh copy at
 * the Now slot, never a climb pulled out of History. A step along a list asks
 * to leave the queue as it is (`keepQueue`), as Next does: the provider keeps
 * it for a look off the climb on the wall (its list's `lookOffWall`), for a
 * queued climb, and for a walk that went through Up next, so the Up next the
 * look walked past or played (a workout's climbs) stays queued. A list's transient
 * `playlist-peek:` item is laundered first, so no peer sees its uuid.
 */
export function resolvePreviewStepCommit({
  previewSuggestionSource,
  targetItem,
  direction,
}: {
  previewSuggestionSource: PlaylistSuggestionSource | null;
  targetItem: ClimbQueueItem;
  direction: QueueNavigationDirection;
}): { item: ClimbQueueItem; options: SetCurrentClimbOptions } {
  const { item, converted } = resolveCommittableQueueItem(targetItem);
  if (previewSuggestionSource) {
    return {
      item,
      options: {
        playlistSuggestionSource: reanchorPlaylistSuggestionSource(previewSuggestionSource, item.climb?.uuid),
        // A step, as Next takes it: the queue stays as it is (#7227).
        keepQueue: true,
        trigger: direction,
        historyCopy: 'fresh',
      },
    };
  }
  return {
    item,
    options: {
      keepWalkedTrack: true,
      ...(converted ? { walkedPeek: true } : {}),
      trigger: direction,
      historyCopy: 'fresh',
    },
  };
}
