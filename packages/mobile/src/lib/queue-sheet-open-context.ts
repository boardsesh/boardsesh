import { upNextStart } from '@boardsesh/queue';
import type { QueueNavigationFrom } from '@boardsesh/analytics';
import type { QueueContentSnapshot } from './queue-undo';
import { getLastPick, resolveBarPick } from './last-pick-store';

/**
 * What `Queue Sheet Opened` says about the queue it opened on
 * (Then-signposts, 2026-11-02): Up next's size, the count the sheet's header
 * shows, and whether the climber was looking at a climb other than the
 * queue's current one.
 *
 * `showsPreview` is the opener's own answer: the player knows whether it shows
 * a preview. Without it (the MiniPlayer, the added-to-queue snackbar) the
 * answer is the bar's: its last pick, while the queue's current is still the
 * one it was made under (`resolveBarPick`). Read at the tap, so opening the
 * sheet subscribes nothing.
 */
export function queueSheetOpenContext(
  { queue, currentClimbQueueItem, historyCount }: QueueContentSnapshot,
  showsPreview?: boolean,
): { from: QueueNavigationFrom; upNextCount: number } {
  const preview = showsPreview ?? resolveBarPick(getLastPick(), currentClimbQueueItem?.uuid ?? null) !== null;
  return {
    from: preview ? 'preview' : 'current',
    upNextCount: Math.max(0, queue.length - upNextStart(queue, currentClimbQueueItem, historyCount)),
  };
}
