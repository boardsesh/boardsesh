import type { QueueEvent, QueueState } from '@boardsesh/shared-schema';
import { redactQueueItem } from './board-session-privacy';

export async function redactQueueState(state: QueueState, viewerId: string | null | undefined): Promise<QueueState> {
  return {
    ...state,
    queue: await Promise.all(state.queue.map((item) => redactQueueItem(item, viewerId))),
    currentClimbQueueItem: state.currentClimbQueueItem
      ? await redactQueueItem(state.currentClimbQueueItem, viewerId)
      : null,
  };
}

/** Live deltas and persisted replay always use the same viewer projection. */
export async function redactQueueEvent(event: QueueEvent, viewerId: string | null | undefined): Promise<QueueEvent> {
  switch (event.__typename) {
    case 'FullSync':
      return { ...event, state: await redactQueueState(event.state, viewerId) };
    case 'QueueItemAdded':
      return { ...event, item: await redactQueueItem(event.item, viewerId) };
    case 'CurrentClimbChanged':
      return {
        ...event,
        item: event.item ? await redactQueueItem(event.item, viewerId) : null,
        frames: null,
      };
    default:
      return event;
  }
}
