import { pubsub } from '../pubsub';
import { createHmac } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { contentVisibilityCondition, sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  SessionUser,
  ClimbQueueItem,
  Climb,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { boardClimbEvents, boardClimbs, boardSessions, userBoards } from '@boardsesh/db/schema';
import { canViewActivityIdentity, canViewContent } from './privacy';

/** Session protocol IDs must never double as profile IDs. */
export function sessionParticipantId(sessionId: string, userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is required for authenticated session identity');
  return createHmac('sha256', secret).update(`boardsesh:session-participant:v1:${sessionId}:${userId}`).digest('hex');
}

/** Unknown persisted event IDs may be account IDs, regardless of their format. */
export function sessionEventParticipantId(
  sessionId: string,
  eventId: string,
  knownProtocolIds: ReadonlyMap<string, string>,
): string {
  return knownProtocolIds.get(eventId) ?? sessionParticipantId(sessionId, eventId);
}

export async function redactSessionUsers(
  users: readonly SessionUser[],
  viewerId: string | null | undefined,
  sessionId: string,
): Promise<SessionUser[]> {
  return Promise.all(
    users.map(async (user) => {
      if (!user.userId) return user;
      const id = sessionParticipantId(sessionId, user.userId);
      if (await canViewActivityIdentity(user.userId, viewerId, { sessionId })) return { ...user, id };
      return { ...user, id, userId: null, username: '', avatarUrl: undefined };
    }),
  );
}

export async function canReadClimbContent(climbUuid: string, viewerId: string | null | undefined): Promise<boolean> {
  const [climb] = await db
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.uuid, climbUuid),
        contentVisibilityCondition('climb', boardClimbs.uuid, boardClimbs.userId, viewerId),
        sprayClimbVisibilityCondition({ boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId }, viewerId),
        or(
          viewerId ? eq(boardClimbs.userId, viewerId) : undefined,
          and(eq(boardClimbs.isDraft, false), eq(boardClimbs.isListed, true)),
        ),
      ),
    )
    .limit(1);
  return !!climb;
}

export async function redactQueueClimb(climb: Climb, viewerId: string | null | undefined): Promise<Climb> {
  if (await canReadClimbContent(climb.uuid, viewerId)) return climb;
  return {
    uuid: climb.uuid,
    name: '',
    setter_username: '',
    frames: '',
    angle: climb.angle,
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}

export async function redactQueueItem(
  item: ClimbQueueItem,
  viewerId: string | null | undefined,
  sessionId: string,
): Promise<ClimbQueueItem> {
  const userId = item.addedByUser?.id ?? item.addedBy;
  const showAuthor = userId && (await canViewActivityIdentity(userId, viewerId, { sessionId }));
  const visibleTicks = await Promise.all(
    (item.tickedBy ?? []).map(async (userId) =>
      (await canViewActivityIdentity(userId, viewerId, { sessionId })) ? userId : null,
    ),
  );
  return {
    ...item,
    climb: await redactQueueClimb(item.climb, viewerId),
    addedBy: showAuthor ? item.addedBy : undefined,
    addedByUser: showAuthor ? item.addedByUser : undefined,
    tickedBy: visibleTicks.filter((userId): userId is string => userId !== null),
  };
}

/** Keep climb chronology intact; only attribution is viewer-dependent. */
export async function redactBoardClimbs(
  climbs: readonly BoardPresenceClimb[],
  boardId: number,
  viewerId: string | null | undefined,
): Promise<BoardPresenceClimb[]> {
  const sequences = climbs.map((climb) => climb.seq);
  const provenance =
    sequences.length === 0
      ? []
      : await db
          .select({
            seq: boardClimbEvents.seq,
            sessionId: boardClimbEvents.sessionId,
            identityPolicyVersion: boardClimbEvents.identityPolicyVersion,
          })
          .from(boardClimbEvents)
          .where(and(eq(boardClimbEvents.boardId, boardId), inArray(boardClimbEvents.seq, sequences)));
  const bySequence = new Map(provenance.map((entry) => [Number(entry.seq), entry]));
  const climbUuids = [...new Set(climbs.map((climb) => climb.climbUuid))];
  const readableClimbs =
    climbUuids.length === 0
      ? []
      : await db
          .select({ uuid: boardClimbs.uuid })
          .from(boardClimbs)
          .where(
            and(
              inArray(boardClimbs.uuid, climbUuids),
              contentVisibilityCondition('climb', boardClimbs.uuid, boardClimbs.userId, viewerId),
              sprayClimbVisibilityCondition(
                { boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId },
                viewerId,
              ),
              or(
                viewerId ? eq(boardClimbs.userId, viewerId) : undefined,
                and(eq(boardClimbs.isDraft, false), eq(boardClimbs.isListed, true)),
              ),
            ),
          );
  const readableUuids = new Set(readableClimbs.map((climb) => climb.uuid));

  return Promise.all(
    climbs.map(async (climb) => {
      const stored = bySequence.get(climb.seq);
      const sessionId = stored?.sessionId ?? climb.sessionId;
      const knownPolicy = (stored?.identityPolicyVersion ?? climb.identityPolicyVersion ?? 0) > 0 || !!sessionId;
      const showIdentity =
        !!climb.sentByUserId &&
        (climb.sentByUserId === viewerId ||
          (knownPolicy && (await canViewActivityIdentity(climb.sentByUserId, viewerId, { sessionId }))));
      const visibleClimb = !readableUuids.has(climb.climbUuid)
        ? { ...climb, name: null, frames: null, setter: null, grade: null, gradeColor: null, queueItemUuid: null }
        : climb;
      return showIdentity
        ? visibleClimb
        : { ...visibleClimb, sentByUserId: null, sentByDisplayName: null, sentByAvatarUrl: null };
    }),
  );
}

export async function redactBoardStats(
  stats: BoardPresenceStats,
  viewerId: string | null | undefined,
): Promise<BoardPresenceStats> {
  const hardest = stats.hardestSend;
  if (!hardest) return stats;
  // A restricted user-created climb is never featured publicly. Aggregate
  // grades and counts above remain unchanged.
  if (!(await canViewContent(viewerId, 'climb', hardest.climbUuid, hardest.climbOwnerId ?? null))) {
    return { ...stats, hardestSend: null };
  }
  const showIdentity =
    hardest.sentByUserId &&
    (hardest.sentByUserId === viewerId ||
      (hardest.tickUuid &&
        (await canViewActivityIdentity(hardest.sentByUserId, viewerId, {
          sessionId: hardest.sessionId,
          entityType: 'tick',
          entityId: hardest.tickUuid,
        }))));
  return showIdentity
    ? stats
    : { ...stats, hardestSend: { ...hardest, sentByUserId: null, sentByDisplayName: null, sentByAvatarUrl: null } };
}

/** A cached BLE holder is identifiable only with current session provenance. */
export async function redactBoardHolder(
  holder: BoardConnectionHolder | null,
  boardId: number,
  viewerId: string | null | undefined,
): Promise<BoardConnectionHolder | null> {
  if (!holder) return null;
  if (holder.userId && holder.userId === viewerId) return holder;
  const sessionId = await pubsub.getBoardSession(String(boardId));
  if (holder.userId && sessionId && (await canViewActivityIdentity(holder.userId, viewerId, { sessionId })))
    return holder;
  return { ...holder, userId: null, displayName: null, avatarUrl: null };
}

export async function redactBoardEvent(
  event: BoardPresenceEvent,
  boardId: number,
  viewerId: string | null | undefined,
): Promise<BoardPresenceEvent> {
  switch (event.__typename) {
    case 'BoardClimbSet':
      return { ...event, climb: (await redactBoardClimbs([event.climb], boardId, viewerId))[0] };
    case 'BoardHistoryUpdated':
      return { ...event, climbs: await redactBoardClimbs(event.climbs, boardId, viewerId) };
    case 'BoardStatsUpdated':
      return { ...event, stats: await redactBoardStats(event.stats, viewerId) };
    case 'BoardConnectionChanged': {
      return { ...event, holder: await redactBoardHolder(event.holder, boardId, viewerId) };
    }
    default:
      return event;
  }
}

/** Revoke public snapshots after the policy transaction has committed. */
export async function notifyResourcePrivacyChanged(kind: 'board' | 'session', resourceId: string): Promise<void> {
  const { republishBoardQueuePreviewsForSession, publishBoardQueuePreviewTombstoneForBoard } =
    await import('./board-queue-preview');
  if (kind === 'board') {
    const [board] = await db
      .select({ id: userBoards.id })
      .from(userBoards)
      .where(eq(userBoards.uuid, resourceId))
      .limit(1);
    if (board) await publishBoardQueuePreviewTombstoneForBoard(Number(board.id));
  } else {
    const [session] = await db
      .select({ boardId: boardSessions.boardId })
      .from(boardSessions)
      .where(eq(boardSessions.id, resourceId))
      .limit(1);
    await republishBoardQueuePreviewsForSession(resourceId, session?.boardId ?? null);
  }
}
