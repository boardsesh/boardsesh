import type { QueueEvent } from '@boardsesh/shared-schema';
import { roomManager } from './room-manager';
import { pubsub } from '../pubsub/index';
import { withQueueVersionRetry } from '../graphql/resolvers/shared/queue-retry';

export class MirrorTargetChangedError extends Error {
  constructor() {
    super('The current climb changed; refresh before mirroring');
  }
}

/** An absolute, queue-slot-scoped write: retries must never toggle twice or flip a new head. */
export async function mirrorSessionClimb(sessionId: string, mirrored: boolean, expectedQueueItemUuid?: string | null) {
  const result = await withQueueVersionRetry('mirrorCurrentClimb', sessionId, async (currentState) => {
    const currentItem = currentState.currentClimbQueueItem;
    if (expectedQueueItemUuid && currentItem?.uuid !== expectedQueueItemUuid) throw new MirrorTargetChangedError();
    if (!currentItem) return null;

    const item = { ...currentItem, climb: { ...currentItem.climb, mirrored } };
    const changed = !!currentItem.climb.mirrored !== mirrored;
    const queue = currentState.queue.map((queuedItem) => (queuedItem.uuid === item.uuid ? item : queuedItem));
    const snapshot = changed
      ? await roomManager.updateQueueState(sessionId, queue, item, currentState.version)
      : currentState;
    const event: Extract<QueueEvent, { __typename: 'ClimbMirrored' }> = {
      __typename: 'ClimbMirrored',
      uuid: item.uuid,
      mirrored,
      sequence: snapshot.sequence,
      stateHash: snapshot.stateHash,
      stateHashOrdered: snapshot.stateHashOrdered,
    };
    return { item, event, changed };
  });
  if (result?.changed) pubsub.publishQueueEvent(sessionId, result.event);
  return result;
}
