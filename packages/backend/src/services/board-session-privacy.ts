import { createHmac } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { parseNamedBoardPath } from '@boardsesh/board-config';
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
import { boardClimbs, boardSessions, resourceGrants, userBoards } from '@boardsesh/db/schema';
import {
  canAccessResource,
  canViewActivityIdentity,
  canViewContent,
  visibleActivityUserIds,
  visibleBoardIdentityIds,
} from './privacy';

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
      if (await canViewActivityIdentity(user.userId, viewerId)) return { ...user, id };
      return { ...user, id, userId: null, username: '', avatarUrl: undefined };
    }),
  );
}

/**
 * Every field that says which board an item happened on. The item (a tick, a
 * session card, a live session) follows its author; the board's own privacy
 * hides only these fields on it.
 */
const BOARD_IDENTITY_FIELDS = [
  'boardId',
  'boardUuid',
  'boardSlug',
  'boardName',
  'boardDisplayName',
  'locationName',
  'gymName',
  'gymUuid',
  'latitude',
  'longitude',
  'distance',
  'distanceMeters',
] as const;
type BoardIdentityField = (typeof BOARD_IDENTITY_FIELDS)[number];

/**
 * Blank the board's identity on an item the viewer may see but whose board
 * they may not (`visibleBoardIdentityUuids` / `boardIdentityVisibleCondition`).
 * Keeps the row: only the fields above become null, and only those present.
 */
export function redactBoardIdentity<T extends Partial<Record<BoardIdentityField, unknown>>>(
  item: T,
  boardIdentityVisible: boolean,
): T {
  if (boardIdentityVisible) return item;
  const redacted: Record<string, unknown> = { ...item };
  for (const field of BOARD_IDENTITY_FIELDS) if (field in redacted) redacted[field] = null;
  return redacted as T;
}

/**
 * A session's board path as this viewer may see it. A named path
 * (`/b/<slug>[/<angle>]`) names its board, and readable sessions can sit on
 * boards the viewer cannot see. Such a viewer gets the board's geometry instead
 * (`/<type>/<layout>/<size>/<sets>/<angle>`): it still draws the board and logs
 * the climbs, so the invite link joins, without the board's slug.
 *
 * A soft-deleted board (a merged one included) keeps its row, so its slug still
 * resolves to geometry; only its owner and anyone it was shared with (an
 * approved grant the row still carries) keep the named path. A slug with no row
 * left at all (renamed since, or its account deleted) names nothing anyone can
 * open, so it comes back as the empty path, which clients read as "no board
 * path". Any other path is returned unchanged.
 *
 * A session invite is not the board's link. A viewer keeps a named path when
 * presenting it in this request or authoring the path-change event, and while
 * that link still opens the board. Creating the session is no proof for its
 * mutable current path, which another member may have selected. Snapshots use
 * ordinary current board standing, or return geometry on reconnect.
 */
export async function projectSessionBoardPath(
  boardPath: string,
  viewerId: string | null | undefined,
  linkHolders: { presentedByViewer?: boolean } = {},
): Promise<string> {
  const named = parseNamedBoardPath(boardPath);
  if (!named) return boardPath;
  const columns = {
    id: userBoards.id,
    uuid: userBoards.uuid,
    ownerId: userBoards.ownerId,
    boardType: userBoards.boardType,
    layoutId: userBoards.layoutId,
    sizeId: userBoards.sizeId,
    setIds: userBoards.setIds,
    angle: userBoards.angle,
  };
  const [live] = await db
    .select(columns)
    .from(userBoards)
    .where(and(eq(userBoards.slug, named.slug), isNull(userBoards.deletedAt)))
    .limit(1);
  // Slugs are unique among live boards only: the latest deletion is the board
  // this path last named.
  const [deleted] = live
    ? []
    : await db
        .select(columns)
        .from(userBoards)
        .where(and(eq(userBoards.slug, named.slug), isNotNull(userBoards.deletedAt)))
        .orderBy(desc(userBoards.deletedAt))
        .limit(1);
  const board = live ?? deleted;
  if (!board) return '';
  const mayName = live
    ? (await visibleBoardIdentityIds([live.id], viewerId)).has(Number(live.id)) ||
      (await holdsLiveBoardLink(live, viewerId, linkHolders))
    : await holdsDeletedBoard(board, viewerId);
  if (mayName) return boardPath;
  return `/${board.boardType}/${board.layoutId}/${board.sizeId}/${board.setIds}/${named.angle ?? board.angle}`;
}

/** The viewer presented this live board's link, and it still opens the board for them. */
async function holdsLiveBoardLink(
  board: { uuid: string; boardType: string },
  viewerId: string | null | undefined,
  linkHolders: { presentedByViewer?: boolean },
): Promise<boolean> {
  const presented = linkHolders.presentedByViewer === true;
  return presented && board.boardType !== 'spray' && (await canAccessResource('board', board.uuid, viewerId));
}

/** A deleted board is still named to its owner and to anyone it was shared with. */
async function holdsDeletedBoard(
  board: { uuid: string; ownerId: string },
  viewerId: string | null | undefined,
): Promise<boolean> {
  if (!viewerId) return false;
  if (board.ownerId === viewerId) return true;
  const [grant] = await db
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.kind, 'board'),
        eq(resourceGrants.resourceId, board.uuid),
        eq(resourceGrants.userId, viewerId),
        eq(resourceGrants.status, 'approved'),
      ),
    )
    .limit(1);
  return !!grant;
}

export async function canReadClimbContent(
  climbUuid: string,
  viewerId: string | null | undefined,
  wallUuid?: string | null,
): Promise<boolean> {
  const [climb] = await db
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.uuid, climbUuid),
        contentVisibilityCondition('climb', boardClimbs.uuid, boardClimbs.userId, viewerId),
        sprayClimbVisibilityCondition(
          { boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId },
          viewerId,
          wallUuid,
        ),
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
): Promise<ClimbQueueItem> {
  const userId = item.addedByUser?.id ?? item.addedBy;
  const showAuthor = userId && (await canViewActivityIdentity(userId, viewerId));
  const visibleTicks = await Promise.all(
    (item.tickedBy ?? []).map(async (userId) => ((await canViewActivityIdentity(userId, viewerId)) ? userId : null)),
  );
  return {
    ...item,
    climb: await redactQueueClimb(item.climb, viewerId),
    addedBy: showAuthor ? item.addedBy : undefined,
    addedByUser: showAuthor ? item.addedByUser : undefined,
    tickedBy: visibleTicks.filter((userId): userId is string => userId !== null),
  };
}

/**
 * Preserve chronology while checking current item and author privacy.
 * A verified presence link opens only its own spray layout; other callers
 * retain the no-link reading by omitting wallUuid.
 */
export async function redactBoardClimbs(
  climbs: readonly BoardPresenceClimb[],
  viewerId: string | null | undefined,
  wallUuid?: string | null,
): Promise<BoardPresenceClimb[]> {
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
                wallUuid,
              ),
              or(
                viewerId ? eq(boardClimbs.userId, viewerId) : undefined,
                and(eq(boardClimbs.isDraft, false), eq(boardClimbs.isListed, true)),
              ),
            ),
          );
  const readableUuids = new Set(readableClimbs.map((climb) => climb.uuid));

  // The sender's account privacy alone decides attribution, whatever session
  // (or none) the send was in and however old the history event is. One query
  // for every sender on the page.
  const visibleSenders = await visibleActivityUserIds(
    climbs.map((climb) => climb.sentByUserId),
    viewerId,
  );
  return climbs.map((climb) => {
    const showIdentity = !!climb.sentByUserId && visibleSenders.has(climb.sentByUserId);
    const visibleClimb = !readableUuids.has(climb.climbUuid)
      ? { ...climb, name: null, frames: null, setter: null, grade: null, gradeColor: null, queueItemUuid: null }
      : climb;
    return showIdentity
      ? visibleClimb
      : { ...visibleClimb, sentByUserId: null, sentByDisplayName: null, sentByAvatarUrl: null };
  });
}

export async function redactBoardStats(
  stats: BoardPresenceStats,
  viewerId: string | null | undefined,
  wallUuid?: string | null,
): Promise<BoardPresenceStats> {
  const hardest = stats.hardestSend;
  if (!hardest) return stats;
  // A restricted user-created climb is never featured publicly. Aggregate
  // grades and counts above remain unchanged.
  if (!(await canViewContent(viewerId, 'climb', hardest.climbUuid, hardest.climbOwnerId ?? null))) {
    return { ...stats, hardestSend: null };
  }
  // Cached metadata may predate a draft, audience or wall-policy change.
  // Known catalog rows must pass the same current item/layout gate as history.
  const [catalogClimb] = await db
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(eq(boardClimbs.uuid, hardest.climbUuid))
    .limit(1);
  if (catalogClimb && !(await canReadClimbContent(hardest.climbUuid, viewerId, wallUuid))) {
    return { ...stats, hardestSend: null };
  }
  // Preserve the missing-catalog grade/Unknown fallback, without replaying a
  // copied name after its row disappears.
  const visibleHardest = catalogClimb ? hardest : { ...hardest, name: null };
  const projectedStats = visibleHardest === hardest ? stats : { ...stats, hardestSend: visibleHardest };
  const showIdentity =
    hardest.sentByUserId &&
    (hardest.sentByUserId === viewerId ||
      (hardest.tickUuid &&
        (await canViewActivityIdentity(hardest.sentByUserId, viewerId, {
          entityType: 'tick',
          entityId: hardest.tickUuid,
        }))));
  return showIdentity
    ? projectedStats
    : {
        ...projectedStats,
        hardestSend: { ...visibleHardest, sentByUserId: null, sentByDisplayName: null, sentByAvatarUrl: null },
      };
}

/** The Bluetooth holder is named by their own account privacy, session or not. */
export async function redactBoardHolder(
  holder: BoardConnectionHolder | null,
  viewerId: string | null | undefined,
): Promise<BoardConnectionHolder | null> {
  if (!holder) return null;
  if (holder.userId && (await canViewActivityIdentity(holder.userId, viewerId))) return holder;
  return { ...holder, userId: null, displayName: null, avatarUrl: null };
}

export async function redactBoardEvent(
  event: BoardPresenceEvent,
  viewerId: string | null | undefined,
  wallUuid?: string | null,
): Promise<BoardPresenceEvent> {
  switch (event.__typename) {
    case 'BoardClimbSet':
      return { ...event, climb: (await redactBoardClimbs([event.climb], viewerId, wallUuid))[0] };
    case 'BoardHistoryUpdated':
      return { ...event, climbs: await redactBoardClimbs(event.climbs, viewerId, wallUuid) };
    case 'BoardStatsUpdated':
      return { ...event, stats: await redactBoardStats(event.stats, viewerId, wallUuid) };
    case 'BoardConnectionChanged': {
      return { ...event, holder: await redactBoardHolder(event.holder, viewerId) };
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
