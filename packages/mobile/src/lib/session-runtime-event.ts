import type { RuntimeSessionEvent } from '@boardsesh/queue-runtime';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { SessionUpdateEvent } from './graphql/operations';

export function toMobileSessionRuntimeEvent(event: SessionUpdateEvent): RuntimeSessionEvent<SessionUser> | null {
  switch (event.__typename) {
    case 'UserJoined':
    case 'UserPresenceChanged':
      return event.user ? { __typename: event.__typename, user: event.user } : null;
    case 'UserLeft':
      return event.userId ? { __typename: 'UserLeft', userId: event.userId } : null;
    case 'LeaderChanged':
      return event.leaderId
        ? {
            __typename: 'LeaderChanged',
            leaderId: event.leaderId,
            leaderConnectionId: event.leaderConnectionId ?? null,
          }
        : null;
    case 'WallDisconnected':
      return {
        __typename: 'WallDisconnected',
        disconnectedByParticipantId: event.disconnectedByParticipantId ?? null,
      };
    case 'SessionBoardSerialChanged':
      return {
        __typename: 'SessionBoardSerialChanged',
        lastConnectedBoardSerial: event.lastConnectedBoardSerial ?? null,
      };
    case 'SessionBoardPathChanged':
      return event.boardPath
        ? {
            __typename: 'SessionBoardPathChanged',
            boardPath: event.boardPath,
            changedByParticipantId: event.changedByParticipantId ?? null,
          }
        : null;
    case 'SessionEnded':
      return { __typename: 'SessionEnded', reason: event.reason ?? null, newPath: event.newPath ?? null };
    default:
      return null;
  }
}
