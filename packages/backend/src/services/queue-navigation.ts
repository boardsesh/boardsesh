import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import type { RoomManager } from './room-manager/room-manager';
import { VersionConflictError } from './room-manager/types';
import type { pubsub as PubSubInstance } from '../pubsub/index';

const MAX_RETRIES = 3;

/**
 * Navigate to a specific queue item by index.
 *
 * Shared logic used by both the GraphQL `setCurrentClimb` mutation and the
 * REST widget-navigate endpoint so the optimistic-locking + event-publish
 * behaviour stays in one place.
 *
 * Returns the selected item and the resulting sequence number, or `null` when
 * the target index is out of bounds / the queue is empty.
 */
export async function navigateToQueueItem(
  sessionId: string,
  targetIndex: number,
  roomManager: RoomManager,
  pubsub: typeof PubSubInstance,
  clientId?: string,
  correlationId?: string,
): Promise<{ item: ClimbQueueItem; sequence: number } | null> {
  let resultItem: ClimbQueueItem | null = null;
  let resultSequence = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const currentState = await roomManager.getQueueState(sessionId);
    const { queue, version } = currentState;

    // Bounds check
    if (queue.length === 0 || targetIndex < 0 || targetIndex >= queue.length) {
      return null;
    }

    const item = queue[targetIndex];

    try {
      const result = await roomManager.updateQueueState(sessionId, queue, item, version);
      resultItem = item;
      resultSequence = result.sequence;
      break; // success
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
        continue; // retry
      }
      throw error;
    }
  }

  if (resultItem) {
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence: resultSequence,
      item: resultItem,
      clientId: clientId ?? null,
      correlationId: correlationId ?? null,
    });
  }

  return resultItem ? { item: resultItem, sequence: resultSequence } : null;
}
