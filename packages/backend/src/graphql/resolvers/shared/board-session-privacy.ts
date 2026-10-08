import type {
  ConnectionContext,
  SessionUser,
  ClimbQueueItem,
  BoardPresenceHardestSend,
  BoardClimbRecentSender,
  SessionParticipant,
  UserBoard,
} from '@boardsesh/shared-schema';
import { canViewActivityIdentity, canViewResourceLocation } from '../../../services/privacy';
import { redactQueueClimb, redactQueueItem, redactSessionUsers } from '../../../services/board-session-privacy';

// These field projections also cover mutation payloads and buffered events;
// the source of an identity must never determine its visibility.
async function visibleIdentity(userId: string | null | undefined, ctx: ConnectionContext): Promise<boolean> {
  return !!userId && canViewActivityIdentity(userId, ctx.userId, { sessionId: ctx.sessionId });
}
function queueProjection(item: ClimbQueueItem, ctx: ConnectionContext) {
  return redactQueueItem(item, ctx.userId, ctx.sessionId ?? '');
}
async function sessionUserProjection(user: SessionUser, ctx: ConnectionContext): Promise<SessionUser> {
  if (!ctx.sessionId) {
    if (await visibleIdentity(user.userId, ctx)) return user;
    return { ...user, username: '', avatarUrl: undefined, userId: null };
  }
  return (await redactSessionUsers([user], ctx.userId, ctx.sessionId))[0];
}

export const boardSessionPrivacyResolvers = {
  UserBoard: {
    ownerId: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(board.ownerId, ctx)) ? board.ownerId : null,
    ownerDisplayName: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(board.ownerId, ctx)) ? board.ownerDisplayName : null,
    ownerAvatarUrl: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(board.ownerId, ctx)) ? board.ownerAvatarUrl : null,
    latitude: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.latitude : null,
    longitude: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.longitude : null,
    locationName: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.locationName : null,
    gymName: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.gymName : null,
    gymUuid: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.gymUuid : null,
    gymId: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.gymId : null,
    distanceMeters: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await canViewResourceLocation(board.uuid, ctx.userId)) ? board.distanceMeters : null,
    serialNumber: (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      board.ownerId === ctx.userId ? board.serialNumber : null,
    timerName: (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      board.ownerId === ctx.userId ? board.timerName : null,
  },
  SessionUser: {
    id: async (user: SessionUser, _: unknown, ctx: ConnectionContext) => (await sessionUserProjection(user, ctx)).id,
    userId: async (user: SessionUser, _: unknown, ctx: ConnectionContext) =>
      (await sessionUserProjection(user, ctx)).userId,
    username: async (user: SessionUser, _: unknown, ctx: ConnectionContext) =>
      (await sessionUserProjection(user, ctx)).username,
    avatarUrl: async (user: SessionUser, _: unknown, ctx: ConnectionContext) =>
      (await sessionUserProjection(user, ctx)).avatarUrl,
  },
  SessionParticipant: {
    userId: async (participant: SessionParticipant, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(participant.userId, ctx)) ? participant.userId : null,
    displayName: async (participant: SessionParticipant, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(participant.userId, ctx)) ? participant.displayName : null,
    avatarUrl: async (participant: SessionParticipant, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(participant.userId, ctx)) ? participant.avatarUrl : null,
  },
  ClimbQueueItem: {
    climb: (item: ClimbQueueItem, _: unknown, ctx: ConnectionContext) => redactQueueClimb(item.climb, ctx.userId),
    addedBy: async (item: ClimbQueueItem, _: unknown, ctx: ConnectionContext) =>
      (await queueProjection(item, ctx)).addedBy,
    addedByUser: async (item: ClimbQueueItem, _: unknown, ctx: ConnectionContext) =>
      (await queueProjection(item, ctx)).addedByUser,
    tickedBy: async (item: ClimbQueueItem, _: unknown, ctx: ConnectionContext) =>
      (await queueProjection(item, ctx)).tickedBy,
  },
  BoardPresenceHardestSend: {
    sentByUserId: async (send: BoardPresenceHardestSend, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(send.sentByUserId, ctx)) ? send.sentByUserId : null,
    sentByDisplayName: async (send: BoardPresenceHardestSend, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(send.sentByUserId, ctx)) ? send.sentByDisplayName : null,
    sentByAvatarUrl: async (send: BoardPresenceHardestSend, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(send.sentByUserId, ctx)) ? send.sentByAvatarUrl : null,
  },
  BoardClimbRecentSender: {
    userId: async (sender: BoardClimbRecentSender, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(sender.userId, ctx)) ? sender.userId : null,
    displayName: async (sender: BoardClimbRecentSender, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(sender.userId, ctx)) ? sender.displayName : null,
    avatarUrl: async (sender: BoardClimbRecentSender, _: unknown, ctx: ConnectionContext) =>
      (await visibleIdentity(sender.userId, ctx)) ? sender.avatarUrl : null,
  },
};
