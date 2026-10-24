import type { QueueEvent } from '@boardsesh/shared-schema';
import { roomManager } from './room-manager';
import { pubsub } from '../pubsub/index';
import { withQueueVersionRetry } from '../graphql/resolvers/shared/queue-retry';
import { normaliseOrphanCurrent } from '@boardsesh/queue';

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
    // The current entry is rewritten in place, so the stored line stands
    // (F3). A stored orphan (a room written before F3) is normalised by this
    // write, which then publishes a FullSync instead of the mirror delta.
    const normalised = normaliseOrphanCurrent({
      queue,
      currentClimbQueueItem: item,
      historyCount: currentState.historyCount,
    });
    const snapshot = changed
      ? await roomManager.updateQueueState(
          sessionId,
          normalised.queue,
          item,
          currentState.version,
          normalised.historyCount,
        )
      : currentState;
    const event: Extract<QueueEvent, { __typename: 'ClimbMirrored' }> = {
      __typename: 'ClimbMirrored',
      uuid: item.uuid,
      mirrored,
      sequence: snapshot.sequence,
      stateHash: snapshot.stateHash,
      stateHashOrdered: snapshot.stateHashOrdered,
    };
    // `event` stays the mirror delta (the widget route echoes its fields);
    // `publishedEvent` is what peers get.
    const publishedEvent: QueueEvent =
      changed && normalised.normalised
        ? {
            __typename: 'FullSync',
            sequence: snapshot.sequence,
            state: {
              sequence: snapshot.sequence,
              stateHash: snapshot.stateHash,
              stateHashOrdered: snapshot.stateHashOrdered,
              queue: normalised.queue,
              currentClimbQueueItem: item,
              historyCount: normalised.historyCount,
              currentChangedAt: snapshot.currentChangedAt,
            },
          }
        : event;
    return { item, event, publishedEvent, changed };
  });
  if (result?.changed) pubsub.publishQueueEvent(sessionId, result.publishedEvent);
  return result;
}
