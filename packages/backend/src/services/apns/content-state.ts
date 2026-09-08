/**
 * Single source of truth for building a `LiveActivityContentState` from a
 * `QueueState`. Called by the queue-event hook, the heartbeat, and the
 * push-token registration resolver.
 *
 * Returns `null` when the session has no current climb (paused / empty queue)
 * or when the current item's uuid isn't present in the queue array (a
 * transient drift state that would otherwise produce an incorrect `hasNext`
 * value with `currentIndex = -1`).
 */

import type { QueueState } from '../room-manager';
import type { LiveActivityContentState } from './index';

export function buildContentStateFromQueueState(queueState: QueueState): LiveActivityContentState | null {
  const currentItem = queueState.currentClimbQueueItem;
  if (!currentItem) return null;

  const currentIndex = queueState.queue.findIndex((item) => item.uuid === currentItem.uuid);
  // currentIndex === -1 means the current item is not in the queue array
  // (transient drift between Postgres and Redis state). Bail rather than
  // emit a `hasNext: true` push the widget would render incorrectly.
  if (currentIndex < 0) return null;

  return {
    climbName: currentItem.climb.name,
    climbDifficulty: currentItem.climb.difficulty,
    angle: currentItem.climb.angle,
    currentIndex,
    totalClimbs: queueState.queue.length,
    hasNext: currentIndex < queueState.queue.length - 1,
    hasPrevious: currentIndex > 0,
    climbUuid: currentItem.climb.uuid,
    queueItemUuid: currentItem.uuid,
    mirrored: currentItem.climb.mirrored === true,
  };
}
