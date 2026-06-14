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
    case 'DriverChanged':
      return {
        __typename: 'DriverChanged',
        driverParticipantId: event.driverParticipantId ?? null,
        previousDriverParticipantId: event.previousDriverParticipantId ?? null,
      };
    case 'WallConnectionChanged':
      // Drives wallConnectionsByBoard in the shared runtime, which
      // deriveIsWallWriter reads to suppress non-holders. Without this case the
      // map stays empty and every connected member falls back to "writer".
      return typeof event.boardId === 'number'
        ? {
            __typename: 'WallConnectionChanged',
            boardId: event.boardId,
            holderParticipantId: event.holderParticipantId ?? null,
          }
        : null;
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
