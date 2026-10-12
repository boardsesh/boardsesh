import type {
  ConnectionContext,
  SessionUser,
  ClimbQueueItem,
  BoardPresenceHardestSend,
  BoardClimbRecentSender,
  SessionParticipant,
  UserBoard,
} from '@boardsesh/shared-schema';
import { canViewActivityIdentity, canViewResourceLocation, visibleActivityUserIds } from '../../../services/privacy';
import {
  boardGymId,
  loadProjectionGym,
  projectBoardLocation,
  type ProjectedBoardLocation,
} from '../../../services/board-location-projection';
import {
  batchedSessionVisibleUserIds,
  canViewBoardHardestSendIdentity,
  hardestSendSourceBoardId,
  queueItemSourceSessionId,
  sessionUserSourceSessionId,
  queueItemUserIds,
  redactQueueAttribution,
  redactQueueClimb,
  redactSessionUsers,
} from '../../../services/board-session-privacy';

// These field projections also cover mutation payloads and buffered events;
// the source of an identity must never determine its visibility.
async function visibleIdentity(userId: string | null | undefined, ctx: ConnectionContext): Promise<boolean> {
  return !!userId && canViewActivityIdentity(userId, ctx.userId);
}
// Context belongs to this server projection, never to a client-supplied field.
// Clone before recording it so a cached sender reused elsewhere cannot inherit
// another board's authorization. Weak keys retain no cross-request objects.
const recentSenderBoards = new WeakMap<BoardClimbRecentSender, number>();
export function withRecentSenderBoardContext(sender: BoardClimbRecentSender, boardId: number): BoardClimbRecentSender {
  const projected = { ...sender };
  recentSenderBoards.set(projected, boardId);
  return projected;
}
const pendingRecentSenderVisibility = new Map<
  string,
  { userIds: Set<string>; visible: Promise<ReadonlySet<string>> }
>();
async function visibleRecentSender(sender: BoardClimbRecentSender, ctx: ConnectionContext): Promise<boolean> {
  if (!sender.userId) return false;
  const boardId = recentSenderBoards.get(sender);
  if (boardId === undefined) return visibleIdentity(sender.userId, ctx);
  const key = JSON.stringify([ctx.userId ?? null, boardId]);
  let pending = pendingRecentSenderVisibility.get(key);
  if (!pending) {
    const userIds = new Set<string>();
    const visible = new Promise<ReadonlySet<string>>((resolve, reject) => {
      void Promise.resolve().then(() =>
        process.nextTick(() => {
          pendingRecentSenderVisibility.delete(key);
          visibleActivityUserIds([...userIds], ctx.userId, { boardId }).then(resolve, reject);
        }),
      );
    });
    pending = { userIds, visible };
    pendingRecentSenderVisibility.set(key, pending);
  }
  pending.userIds.add(sender.userId);
  // Recheck current membership/policy for each GraphQL batch, including retained
  // objects after revocation. Account-only objects keep the narrower fallback.
  return (await pending.visible).has(sender.userId);
}
// Each field of each queue item or roster entry asks separately; the batched
// lookup answers every one of them for a projection with one board resolution
// and one query. The `climb` field projects the climb itself. This judges on the
// connection's session, which is the item's for a session member; a producer
// whose caller has none (HTTP, the ESP32 controller's navigateQueue) projects
// the item against its own session before returning it, and this can only
// narrow that further.
async function queueProjection(item: ClimbQueueItem, ctx: ConnectionContext) {
  return redactQueueAttribution(
    item,
    await batchedSessionVisibleUserIds(
      queueItemUserIds([item]),
      ctx.userId,
      queueItemSourceSessionId(item) === undefined ? ctx.sessionId : queueItemSourceSessionId(item),
    ),
  );
}
async function sessionUserProjection(user: SessionUser, ctx: ConnectionContext): Promise<SessionUser> {
  const sessionId = sessionUserSourceSessionId(user) ?? ctx.sessionId;
  if (!sessionId) {
    if (await visibleIdentity(user.userId, ctx)) return user;
    return { ...user, username: '', avatarUrl: undefined, userId: null };
  }
  const visible = batchedSessionVisibleUserIds([user.userId], ctx.userId, sessionId);
  return (await redactSessionUsers([user], ctx.userId, sessionId, await visible))[0];
}

const pendingHardestSendVisibility = new WeakMap<BoardPresenceHardestSend, Map<string | null, Promise<boolean>>>();
function visibleHardestSend(send: BoardPresenceHardestSend, ctx: ConnectionContext): Promise<boolean> {
  const boardId = hardestSendSourceBoardId(send);
  if (boardId === undefined) return visibleIdentity(send.sentByUserId, ctx);
  const viewerId = ctx.userId ?? null;
  const pending = pendingHardestSendVisibility.get(send) ?? new Map<string | null, Promise<boolean>>();
  pendingHardestSendVisibility.set(send, pending);
  const existing = pending.get(viewerId);
  if (existing) return existing;
  const visibility = canViewBoardHardestSendIdentity(send, viewerId, boardId).finally(() => pending.delete(viewerId));
  pending.set(viewerId, visibility);
  return visibility;
}

type BoardLocationField = ProjectedBoardLocation & { distanceMeters: number | null };
// Per board object AND per viewer, like `pendingHardestSendVisibility`: the
// decision is the viewer's, so one object resolved for two viewers must never
// hand the second the first one's answer. An entry lives only while its seven
// field resolvers share it.
const pendingBoardLocations = new WeakMap<UserBoard, Map<string | null, Promise<BoardLocationField>>>();

/**
 * The place a UserBoard shows this viewer, from `projectBoardLocation`, decided
 * once per board object and viewer for all of its location fields. This is the last line
 * for every producer of a UserBoard (queries, mutation payloads, events): a
 * viewer the owner hid the board's place from gets its public gym's listed
 * place, read from the gym row itself, never from the object, which a
 * producer may have filled with the board's own place.
 */
function boardLocationField(board: UserBoard, ctx: ConnectionContext): Promise<BoardLocationField> {
  const viewerId = ctx.userId ?? null;
  const pending = pendingBoardLocations.get(board) ?? new Map<string | null, Promise<BoardLocationField>>();
  pendingBoardLocations.set(board, pending);
  const existing = pending.get(viewerId);
  if (existing) return existing;
  const decided = (async (): Promise<BoardLocationField> => {
    if (await canViewResourceLocation(board.uuid, viewerId)) {
      return {
        locationName: board.locationName ?? null,
        latitude: board.latitude ?? null,
        longitude: board.longitude ?? null,
        gymId: board.gymId ?? null,
        gymUuid: board.gymUuid ?? null,
        gymName: board.gymName ?? null,
        source: 'own',
        distanceMeters: board.distanceMeters ?? null,
      };
    }
    const gymId = await boardGymId(board.uuid);
    const location = projectBoardLocation(
      { locationName: null, latitude: null, longitude: null, gymId },
      await loadProjectionGym(gymId),
      false,
    );
    return { ...location, distanceMeters: null };
  })();
  // Dropped once settled, so a later read (another request reusing the object,
  // or the same viewer after a privacy change) decides afresh.
  const tracked = decided.finally(() => pending.delete(viewerId));
  pending.set(viewerId, tracked);
  return tracked;
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
      (await boardLocationField(board, ctx)).latitude,
    longitude: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await boardLocationField(board, ctx)).longitude,
    locationName: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await boardLocationField(board, ctx)).locationName,
    gymName: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await boardLocationField(board, ctx)).gymName,
    gymUuid: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await boardLocationField(board, ctx)).gymUuid,
    gymId: async (board: UserBoard, _: unknown, ctx: ConnectionContext) => (await boardLocationField(board, ctx)).gymId,
    distanceMeters: async (board: UserBoard, _: unknown, ctx: ConnectionContext) =>
      (await boardLocationField(board, ctx)).distanceMeters,
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
      (await visibleHardestSend(send, ctx)) ? send.sentByUserId : null,
    sentByDisplayName: async (send: BoardPresenceHardestSend, _: unknown, ctx: ConnectionContext) =>
      (await visibleHardestSend(send, ctx)) ? send.sentByDisplayName : null,
    sentByAvatarUrl: async (send: BoardPresenceHardestSend, _: unknown, ctx: ConnectionContext) =>
      (await visibleHardestSend(send, ctx)) ? send.sentByAvatarUrl : null,
  },
  BoardClimbRecentSender: {
    userId: async (sender: BoardClimbRecentSender, _: unknown, ctx: ConnectionContext) =>
      (await visibleRecentSender(sender, ctx)) ? sender.userId : null,
    displayName: async (sender: BoardClimbRecentSender, _: unknown, ctx: ConnectionContext) =>
      (await visibleRecentSender(sender, ctx)) ? sender.displayName : null,
    avatarUrl: async (sender: BoardClimbRecentSender, _: unknown, ctx: ConnectionContext) =>
      (await visibleRecentSender(sender, ctx)) ? sender.avatarUrl : null,
  },
};
