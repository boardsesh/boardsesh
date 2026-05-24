import type { ConnectionContext, SessionEvent } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { requireSessionMember } from '../shared/helpers';
import { createAsyncIterator } from '../shared/async-iterators';
import { logger } from '../../../utils/logger';

export const sessionSubscriptions = {
  /**
   * Subscribe to real-time session events
   * Sends events when users join/leave or leadership changes
   * Requires user to be a member of the session
   */
  sessionUpdates: {
    subscribe: async function* (_: unknown, { sessionId }: { sessionId: string }, ctx: ConnectionContext) {
      // Verify user is a member of the session they're subscribing to
      // Uses retry logic to handle race conditions with joinSession
      try {
        await requireSessionMember(ctx, sessionId);
      } catch (error) {
        // Only swallow the expected reconnection-race auth failure. Real
        // infrastructure errors (Redis, network) must still propagate.
        if (error instanceof Error && error.message.startsWith('Unauthorized')) {
          logger.warn(`[Session] Subscription ended: connection ${ctx.connectionId} not in session ${sessionId}`);
          return;
        }
        throw error;
      }

      // Create async iterator for subscription
      // NOTE: We await here to ensure Redis subscription is established
      // before proceeding - this is critical for multi-instance sync.
      const asyncIterator = await createAsyncIterator<SessionEvent>((push) => {
        return pubsub.subscribeSession(sessionId, push);
      });

      for await (const event of asyncIterator) {
        yield { sessionUpdates: event };
      }
    },
  },
};
