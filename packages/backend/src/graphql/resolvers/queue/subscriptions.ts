import type { ConnectionContext, QueueEvent } from '@boardsesh/shared-schema';
import { roomManager } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { requireSessionMember } from '../shared/helpers';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { logger } from '../../../utils/logger';

export const queueSubscriptions = {
  /**
   * Subscribe to real-time queue updates
   * Sends initial FullSync event followed by incremental updates
   * Uses eager subscription to prevent race conditions
   */
  queueUpdates: {
    subscribe: async function* (_: unknown, { sessionId }: { sessionId: string }, ctx: ConnectionContext) {
      // Verify user is a member of the session they're subscribing to
      // Uses retry logic to handle race conditions with joinSession
      try {
        await requireSessionMember(ctx, sessionId);
      } catch (error) {
        // Only swallow the expected reconnection-race auth failure. Real
        // infrastructure errors (Redis, network) must still propagate.
        if (error instanceof Error && error.message.startsWith('Unauthorized')) {
          logger.warn(`[Queue] Subscription ended: connection ${ctx.connectionId} not in session ${sessionId}`);
          return;
        }
        throw error;
      }

      // IMPORTANT: Subscribe to pubsub FIRST, before fetching state.
      // This prevents a race condition where events could be published
      // between fetching the queue state and starting to listen.
      // Events that arrive before we yield FullSync will be queued.
      // NOTE: We await here to ensure Redis subscription is established
      // before proceeding - this is critical for multi-instance sync.
      const asyncIterator = await createEagerAsyncIterator<QueueEvent>((push) => {
        return pubsub.subscribeQueue(sessionId, push);
      });

      // Now fetch the current state (any events during this time are queued)
      const queueState = await roomManager.getQueueState(sessionId);
      const fullSyncSequence = queueState.sequence;

      // Send initial FullSync
      yield {
        queueUpdates: {
          __typename: 'FullSync',
          sequence: fullSyncSequence,
          state: queueState,
        } as QueueEvent,
      };

      // Continue with queued and new events
      // Filter out events with sequence <= fullSyncSequence to prevent:
      // 1. Duplicate events (already included in FullSync state)
      // 2. Sequence gap detection on client (e.g., FullSync seq=7, then event seq=3)
      // Events queued between subscribing and fetching state will have lower sequences.
      //
      // PlaybackStateChanged is exempt: it doesn't mutate queue state, isn't
      // buffered for replay, and reuses the room's current sequence number
      // for ordering — which equals `fullSyncSequence` until the next queue
      // mutation. Always forward it so peers receive playback updates issued
      // immediately after subscribing.
      for await (const event of asyncIterator) {
        if (event.__typename === 'PlaybackStateChanged' || event.sequence > fullSyncSequence) {
          yield { queueUpdates: event };
        }
      }
    },
  },
};
