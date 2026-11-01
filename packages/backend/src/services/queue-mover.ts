import type { ConnectionContext } from '@boardsesh/shared-schema';
import { getContext } from '../graphql/context';
import { getDistributedState } from './distributed-state';
import { roomManager } from './room-manager';
import { sessionParticipantId } from './board-session-privacy';

/** Resolve the server-bound identity after reconnect grace has admitted the move. */
export async function resolveQueueMoverParticipantId(
  ctx: ConnectionContext,
  sessionId: string,
): Promise<string | null> {
  const liveContext = getContext(ctx.connectionId);
  if (liveContext?.sessionId === sessionId && liveContext.participantId) return liveContext.participantId;
  const client = roomManager.getClient(ctx.connectionId);
  if (client?.sessionId === sessionId && client.participantId) return client.participantId;
  if (ctx.sessionId === sessionId && ctx.participantId) return ctx.participantId;

  // A recovered mutation can still hold its pre-JOIN context snapshot. The
  // binding was verified by requireSessionWithReconnectGrace; use its live
  // distributed participant instead of guessing from queue-item authorship.
  const distributed = getDistributedState();
  if (distributed) {
    try {
      const connection = await distributed.getConnection(ctx.connectionId);
      if (connection?.sessionId === sessionId && connection.participantId) return connection.participantId;
    } catch {
      // Attribution is optional; a Redis read failure must not reject a move.
    }
  }
  if (ctx.userId) return sessionParticipantId(sessionId, ctx.userId);
  return ctx.sessionId === sessionId ? ctx.connectionId : null;
}
