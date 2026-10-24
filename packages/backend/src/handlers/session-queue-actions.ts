import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';
import { historyLine, upNextStart } from '@boardsesh/queue';
import { navigateToQueueItem, setCurrentClimbAndPublish } from '../services/queue-navigation';
import { isNowSlotSession } from '../services/queue-now-slot-rollout';

export type NavigateAction = 'next' | 'previous';

/**
 * Outcome of {@link navigateSessionQueue}. A discriminated union so each caller
 * maps it to its own HTTP status + analytics without re-deriving the queue math.
 * The extra index/length fields on `ok`/`out_of_bounds` carry exactly what the
 * iOS-widget analytics payload needs (`queueLength`, `serverCurrentIndex`,
 * `targetIndex`).
 */
export type NavigateOutcome =
  | { kind: 'ok'; currentIndex: number; queueLength: number; serverCurrentIndex: number; targetIndex: number }
  | { kind: 'queue_empty' }
  | { kind: 'out_of_bounds'; queueLength: number; serverCurrentIndex: number; targetIndex: number };

/**
 * Advance/rewind a session's current climb by one queue position and publish
 * the resulting `CurrentClimbChanged` to every member.
 *
 * The server resolves the authoritative position from `roomManager` (never
 * trusting a client-supplied index — a peer may have moved the queue), so both
 * the iOS lock-screen widget (`/api/widget/navigate`) and the Garmin watch
 * (`/api/session/navigate`) share one implementation of the index math +
 * event publish. `correlationId` tags the published event so the originating
 * client can echo-suppress its own change.
 *
 * F3 (docs/current-climb-outside-queue.md, section 3): Next goes to Up next[0]
 * and Previous to History's last entry, read with `upNextStart` /
 * `historyLine`, so with nothing current Next lands on `queue[historyCount]`
 * rather than the oldest History climb. Inside `QUEUE_NOW_SLOT_PERCENT` it
 * stops at the ends (`out_of_bounds`), as controller `navigateQueue` does:
 * wrapping sent every Up next climb to History unclimbed (Previous from the
 * start) or spilled all of History into Up next (Next from the end). Outside
 * the percent it still wraps.
 */
export async function navigateSessionQueue(
  sessionId: string,
  action: NavigateAction,
  correlationId: string,
): Promise<NavigateOutcome> {
  const queueState = await roomManager.getQueueState(sessionId);
  const queueLength = queueState.queue.length;

  if (queueLength === 0) {
    return { kind: 'queue_empty' };
  }

  // Use the server's authoritative current index, not any client-supplied one
  // which may be stale (another user changed the climb while the caller's local
  // state was out of date). The analytics field keeps its old meaning: 0 with
  // nothing current.
  const currentItem = queueState.currentClimbQueueItem;
  const currentIndex = currentItem ? queueState.queue.findIndex((q) => q.uuid === currentItem.uuid) : -1;
  const serverCurrentIndex = currentItem ? currentIndex : 0;
  const nextIndex = upNextStart(queueState.queue, currentItem, queueState.historyCount);
  const previousIndex = historyLine(queueState) - 1;

  let targetIndex = action === 'next' ? nextIndex : previousIndex;
  if (targetIndex < 0 || targetIndex >= queueLength) {
    if (isNowSlotSession(sessionId)) {
      return { kind: 'out_of_bounds', queueLength, serverCurrentIndex, targetIndex };
    }
    targetIndex = action === 'next' ? 0 : queueLength - 1;
  }

  const result = await navigateToQueueItem(sessionId, targetIndex, roomManager, pubsub, undefined, correlationId);

  if (!result) {
    return { kind: 'out_of_bounds', queueLength, serverCurrentIndex, targetIndex };
  }

  return { kind: 'ok', currentIndex: targetIndex, queueLength, serverCurrentIndex, targetIndex };
}

/**
 * Re-assert the session's current climb: re-publish it as the current climb so
 * any BLE-capable phone in the session re-sends it to the wall. With no current
 * climb it's a successful no-op. Shared by `/api/widget/take-control` and
 * `/api/session/take-control`.
 */
export async function reassertSessionCurrentClimb(sessionId: string, correlationId: string): Promise<void> {
  const queueState = await roomManager.getQueueState(sessionId);
  const currentItem = queueState.currentClimbQueueItem;
  if (!currentItem) {
    return;
  }
  // shouldAddToQueue=false — the climb is already in the queue, so this only
  // re-publishes CurrentClimbChanged to every member.
  await setCurrentClimbAndPublish(sessionId, currentItem, false, roomManager, pubsub, undefined, correlationId);
}
