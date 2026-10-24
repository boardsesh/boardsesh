import type { ClimbQueueItem, QueueState as WireQueueState } from '@boardsesh/shared-schema';
import type { pubsub as PubSubInstance } from '../pubsub/index';
import type { QueueWriteResult } from './room-manager/types';

/**
 * Event builders shared by the F3 writers (docs/current-climb-outside-queue.md,
 * section 2), so every `FullSync` carries `historyCount` and `currentChangedAt`
 * and every trailing `CurrentClimbChanged` is published the same way.
 */

/** The wire `QueueState` a write produced. */
export function wireQueueState(
  write: QueueWriteResult,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
): WireQueueState {
  return {
    sequence: write.sequence,
    stateHash: write.stateHash,
    stateHashOrdered: write.stateHashOrdered,
    queue,
    currentClimbQueueItem,
    historyCount: write.historyCount,
    currentChangedAt: write.currentChangedAt,
  };
}

export function publishFullSync(
  pubsub: typeof PubSubInstance,
  sessionId: string,
  write: QueueWriteResult,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
): WireQueueState {
  const state = wireQueueState(write, queue, currentClimbQueueItem);
  pubsub.publishQueueEvent(sessionId, { __typename: 'FullSync', sequence: write.sequence, state });
  return state;
}

/**
 * The trailing `CurrentClimbChanged` after a reshaping `FullSync`: same
 * sequence, the origin's `clientId`, `correlationId: null`, and outside the
 * replay buffer. The native Live Activity socket repaints the wall only on
 * `CurrentClimbChanged` (`QueueEventRepaintPolicy`), and accepts an equal
 * sequence (pinned by `ios-tests/LiveActivityWidgetTests.swift`), so this keeps
 * a backgrounded phone lighting every move that used to be a pointer event.
 * JS clients drop it as `ignore-stale`. A `null` correlation id means no
 * shipped reducer can drop it as its own echo.
 */
export function publishTrailingCurrentClimb(
  pubsub: typeof PubSubInstance,
  sessionId: string,
  write: QueueWriteResult,
  currentClimbQueueItem: ClimbQueueItem,
  clientId: string | null,
): void {
  pubsub.publishQueueEvent(
    sessionId,
    {
      __typename: 'CurrentClimbChanged',
      sequence: write.sequence,
      stateHash: write.stateHash,
      stateHashOrdered: write.stateHashOrdered,
      item: currentClimbQueueItem,
      clientId,
      correlationId: null,
    },
    { buffer: false },
  );
}
