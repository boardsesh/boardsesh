import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import type { RoomManager } from './room-manager/room-manager';
import { VersionConflictError } from './room-manager/types';
import type { pubsub as PubSubInstance } from '../pubsub/index';
import { MAX_RETRIES } from '../graphql/resolvers/shared/types';

/**
 * Set the current climb (optionally appending it to the queue) and publish the
 * resulting queue event. Mirrors the body of the GraphQL `setCurrentClimb`
 * resolver so other call sites (the widget re-assert handler) can re-use the
 * optimistic-locking + event-publish logic without duplicating it.
 *
 * Accepts `item: null` to clear the current climb. The `shouldAddToQueue` arg
 * is ignored on the null path (no climb to add) and `pushRecentClimb` is
 * skipped. The published event is always `CurrentClimbChanged { item: null }`
 * on that path — never `FullSync`.
 *
 * Returns the persisted queue state for resolvers that need to echo it back.
 */
export async function setCurrentClimbAndPublish(
  sessionId: string,
  item: ClimbQueueItem | null,
  shouldAddToQueue: boolean,
  roomManager: RoomManager,
  pubsub: typeof PubSubInstance,
  clientId?: string | null,
  correlationId?: string | null,
): Promise<{ sequence: number; stateHash: string; queue: ClimbQueueItem[]; addedToQueue: boolean }> {
  let sequence = 0;
  let stateHash = '';
  let addedToQueue = false;
  let updatedQueue: ClimbQueueItem[] = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const currentState = await roomManager.getQueueState(sessionId);
    let queue = currentState.queue;
    let addedInThisAttempt = false;

    if (item !== null && shouldAddToQueue && !queue.some((i) => i.uuid === item.uuid)) {
      queue = [...queue, item];
      addedInThisAttempt = true;
    }

    try {
      const result = await roomManager.updateQueueState(sessionId, queue, item, currentState.version);
      sequence = result.sequence;
      stateHash = result.stateHash;
      updatedQueue = queue;
      addedToQueue = addedInThisAttempt;
      break;
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw error;
    }
  }

  // Null-item path: queue updated to clear `currentClimbQueueItem`, nothing
  // to add and no climb uuid to record. Early-return so the rest of the
  // function can assume `item` is non-null.
  if (item === null) {
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence,
      stateHash,
      item: null,
      clientId: clientId ?? null,
      correlationId: correlationId ?? null,
    });
    return { sequence, stateHash, queue: updatedQueue, addedToQueue: false };
  }

  // Record the climb as the latest authoritative wall climb so the next
  // `confirmClimbOnWall` accepts it even if the driver navigates on before
  // the confirm arrives. Best-effort: don't fail the publish if the recency
  // record breaks (Redis hiccup).
  await roomManager.pushRecentClimb(sessionId, item.climb.uuid).catch(() => undefined);

  if (addedToQueue) {
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'FullSync',
      sequence,
      state: { sequence, stateHash, queue: updatedQueue, currentClimbQueueItem: item },
    });
  } else {
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence,
      stateHash,
      item,
      clientId: clientId ?? null,
      correlationId: correlationId ?? null,
    });
  }

  return { sequence, stateHash, queue: updatedQueue, addedToQueue };
}

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
  let resultStateHash = '';

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
      resultStateHash = result.stateHash;
      break; // success
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < MAX_RETRIES - 1) {
        continue; // retry
      }
      throw error;
    }
  }

  if (resultItem) {
    // Record the climb in the session's recent-climbs ring buffer so a
    // confirmClimbOnWall arriving after a quick navigate-on still correlates.
    // See setCurrentClimbAndPublish above for the rationale.
    await roomManager.pushRecentClimb(sessionId, resultItem.climb.uuid).catch(() => undefined);
    pubsub.publishQueueEvent(sessionId, {
      __typename: 'CurrentClimbChanged',
      sequence: resultSequence,
      stateHash: resultStateHash,
      item: resultItem,
      clientId: clientId ?? null,
      correlationId: correlationId ?? null,
    });
  }

  return resultItem ? { item: resultItem, sequence: resultSequence } : null;
}
