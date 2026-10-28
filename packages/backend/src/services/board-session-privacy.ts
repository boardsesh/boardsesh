import { createHmac } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { parseNamedBoardPath } from '@boardsesh/board-config';
import {
  ownedOrPublicClimbCondition,
  sessionCoMemberCondition,
  sprayClimbVisibilityCondition,
} from '@boardsesh/db/queries';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
  BoardPresenceHardestSend,
  SessionUser,
  SessionParticipant,
  ClimbQueueItem,
  Climb,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  boardClimbs,
  boardSessions,
  contentPrivacy,
  resourceGrants,
  userBoards,
  users as accounts,
} from '@boardsesh/db/schema';
import { batchedLookup, type PendingLookups } from './batched-lookup';
import {
  anonymousOnBoardUserIds,
  canAccessResource,
  canViewActivityIdentity,
  canViewContent,
  anonymousOnBoardUserIdsByBoard,
  visibleActivityUserIds,
  visibleActivityUserIdsByBoard,
  visibleBoardIdentityIds,
} from './privacy';
import { resolveSessionBoards, type SessionBoardSource } from './session-board';

type ViewerId = string | null | undefined;

// Provenance belongs to a cloned server projection, never a client-supplied field.
const rosterSourceSessions = new WeakMap<SessionUser, string>();
const queueSourceSessions = new WeakMap<ClimbQueueItem, string | null>();
const hardestSendSourceBoards = new WeakMap<BoardPresenceHardestSend, number>();
const summaryParticipantSourceSessions = new WeakMap<SessionParticipant, string>();

export const sessionUserSourceSessionId = (user: SessionUser) => rosterSourceSessions.get(user);
export const queueItemSourceSessionId = (item: ClimbQueueItem) => queueSourceSessions.get(item);
export const hardestSendSourceBoardId = (send: BoardPresenceHardestSend) => hardestSendSourceBoards.get(send);
export const summaryParticipantSourceSessionId = (participant: SessionParticipant) =>
  summaryParticipantSourceSessions.get(participant);

/**
 * A session summary's participant row, cloned with the session it was projected
 * for, so its GraphQL fields can let a fellow member of that session keep the
 * name (`sessionCoMemberIds`) where account privacy alone would blank it.
 */
export function withSummaryParticipantSession<T extends SessionParticipant>(participant: T, sessionId: string): T {
  const projected = { ...participant };
  summaryParticipantSourceSessions.set(projected, sessionId);
  return projected;
}

/** Session protocol IDs must never double as profile IDs. */
export function sessionParticipantId(sessionId: string, userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is required for authenticated session identity');
  return createHmac('sha256', secret).update(`boardsesh:session-participant:v1:${sessionId}:${userId}`).digest('hex');
}

/**
 * An opaque stand-in for the climber on one anonymous log. Unique to the log,
 * so a page of them never becomes a list of stable pseudonyms.
 */
export function anonymousLogAuthorId(tickUuid: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is required for anonymous log identity');
  return createHmac('sha256', secret).update(`boardsesh:anonymous-log-author:v1:${tickUuid}`).digest('hex');
}

/** Unknown persisted event IDs may be account IDs, regardless of their format. */
export function sessionEventParticipantId(
  sessionId: string,
  eventId: string,
  knownProtocolIds: ReadonlyMap<string, string>,
): string {
  return knownProtocolIds.get(eventId) ?? sessionParticipantId(sessionId, eventId);
}

const distinctIds = (userIds: readonly (string | null | undefined)[]): string[] => [
  ...new Set(userIds.filter((userId): userId is string => !!userId)),
];

type SessionRows = readonly { session: SessionBoardSource; userIds: readonly (string | null | undefined)[] }[];

/**
 * The (climbers, board) rows a live session's climbers are judged on: the one
 * board the session is on (`resolveSessionBoards`; pass `boards` when that is
 * already resolved). A session nothing places on an identified board fails
 * closed, even when the climber owns a board with the same config: a common
 * layout cannot establish which physical wall the session is using.
 */
async function sessionBoardRows(rows: SessionRows, viewerId: ViewerId, boards?: ReadonlyMap<string, number>) {
  const candidates = rows.map(({ session, userIds }) => ({ session, userIds: distinctIds(userIds) }));
  if (candidates.every(({ userIds }) => userIds.length === 0)) return { candidates, queryRows: [] };
  const boardBySession =
    boards ??
    (await resolveSessionBoards(candidates.flatMap(({ session, userIds }) => (userIds.length ? [session] : []))));
  const queryRows = candidates.map(({ session, userIds }, rowIndex) => ({
    rowIndex,
    userIds,
    onBoard: { boardId: boardBySession.get(session.id) ?? null, sessionId: session.id },
  }));
  return { candidates, queryRows };
}

/** Fold per-query-row results back onto the caller's rows. */
function mergeRows(count: number, queryRows: readonly { rowIndex: number }[], found: readonly Set<string>[]) {
  const merged = Array.from({ length: count }, () => new Set<string>());
  queryRows.forEach(({ rowIndex }, queryIndex) => {
    for (const userId of found[queryIndex]) merged[rowIndex].add(userId);
  });
  return merged;
}

/**
 * `visibleActivityUserIds` for rows of live sessions, each judged on the one
 * board its session is on (`sessionBoardRows`). One query for every row, plus
 * the board resolution. Unidentified sessions use the same anonymous rule.
 * Listings (Climbing now, nearby discovery) call this directly: they are
 * board-facing, so being a fellow member of a listed session names nobody
 * there. A session's own surfaces use `sessionVisibleUserIds`.
 */
export async function sessionsVisibleUserIds(
  rows: SessionRows,
  viewerId: ViewerId,
  boards?: ReadonlyMap<string, number>,
): Promise<Set<string>[]> {
  const { candidates, queryRows } = await sessionBoardRows(rows, viewerId, boards);
  return mergeRows(candidates.length, queryRows, await visibleActivityUserIdsByBoard(queryRows, viewerId));
}

/** A session's own row, for the board resolution; a vanished session has nothing to place it. */
async function loadSessionBoardSource(sessionId: string): Promise<SessionBoardSource> {
  const [session] = await db
    .select({
      id: boardSessions.id,
      boardId: boardSessions.boardId,
      boardPath: boardSessions.boardPath,
      createdByUserId: boardSessions.createdByUserId,
    })
    .from(boardSessions)
    .where(eq(boardSessions.id, sessionId))
    .limit(1);
  return session ?? { id: sessionId, boardId: null, boardPath: null, createdByUserId: null };
}

type CoMemberRows = readonly { sessionId: string; userIds: readonly (string | null | undefined)[] }[];

/**
 * The climbers on each row the viewer shares that row's session with
 * (`sessionCoMemberCondition`, #6582), in the order given: on that session's
 * own surfaces, a fellow member is named whatever their account privacy or
 * "Stay anonymous on boards I don't own" says. One statement for every row,
 * none without a viewer. Read from the primary: a joiner's participant row is
 * written just before `UserJoined` goes out. A daily card's synthetic id is not
 * a session and has no members.
 */
export async function sessionsCoMemberIds(rows: CoMemberRows, viewerId: ViewerId): Promise<Set<string>[]> {
  const found = rows.map(() => new Set<string>());
  if (!viewerId) return found;
  const candidates = rows.flatMap(({ sessionId, userIds }, rowIndex) =>
    sessionId.startsWith('daily:')
      ? []
      : distinctIds(userIds)
          .filter((userId) => userId !== viewerId)
          .map((userId) => ({ rowIndex, userId, sessionId })),
  );
  if (candidates.length === 0) return found;
  // One session: bind it, so the viewer's half of the test runs once.
  const sessionIds = new Set(candidates.map(({ sessionId }) => sessionId));
  const sessionIdSql = sessionIds.size === 1 ? sql`${candidates[0].sessionId}::text` : sql`co_row.session_id`;
  const values = candidates.map(
    ({ rowIndex, userId, sessionId }) => sql`(${rowIndex}::int, ${userId}::text, ${sessionId}::text)`,
  );
  const matches = await db
    .select({ rowIndex: sql<number>`co_row.row_index`, userId: accounts.id })
    .from(sql`(VALUES ${sql.join(values, sql`, `)}) AS co_row(row_index, user_id, session_id)`)
    .innerJoin(accounts, eq(accounts.id, sql`co_row.user_id`))
    .where(sessionCoMemberCondition(accounts.id, sessionIdSql, viewerId));
  for (const { rowIndex, userId } of matches) found[Number(rowIndex)]?.add(userId);
  return found;
}

/** `sessionsCoMemberIds` for one session. */
export async function sessionCoMemberIds(
  userIds: readonly (string | null | undefined)[],
  viewerId: ViewerId,
  sessionId: string,
): Promise<Set<string>> {
  return (await sessionsCoMemberIds([{ sessionId, userIds }], viewerId))[0];
}

/**
 * Climbers who show as anonymous in this live session: they stay anonymous on
 * boards they don't own and the session's board is not theirs, and the viewer
 * is not a fellow member of the session (`sessionCoMemberIds`). For rows whose
 * identity follows the logs' own audience rather than the account (session
 * detail, the session summary).
 */
export async function sessionAnonymousUserIds(
  userIds: readonly (string | null | undefined)[],
  viewerId: ViewerId,
  sessionId: string,
): Promise<ReadonlySet<string>> {
  const others = distinctIds(userIds).filter((userId) => userId !== viewerId);
  if (others.length === 0) return new Set();
  const { queryRows } = await sessionBoardRows(
    [{ session: await loadSessionBoardSource(sessionId), userIds: others }],
    viewerId,
  );
  const anonymous = mergeRows(1, queryRows, await anonymousOnBoardUserIdsByBoard(queryRows, viewerId))[0];
  if (anonymous.size === 0) return anonymous;
  for (const userId of await sessionCoMemberIds([...anonymous], viewerId, sessionId)) anonymous.delete(userId);
  return anonymous;
}

/**
 * Climbers a live session's rows (roster, queue attribution, host, Live
 * Activity holder) may name: their account lets the viewer see them and they do
 * not stay anonymous on the session's board (`sessionsVisibleUserIds`), or they
 * are a fellow member of the session (`sessionCoMemberIds`), which is read only
 * for the climbers the first test left out. None of it when the only climber is
 * the viewer, who always sees their own name. Outside a session (`sessionId`
 * null) only the account decides.
 */
export async function sessionVisibleUserIds(
  userIds: readonly (string | null | undefined)[],
  viewerId: ViewerId,
  sessionId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  const candidates = distinctIds(userIds);
  const self = viewerId && candidates.includes(viewerId) ? [viewerId] : [];
  if (candidates.length === self.length) return new Set(self);
  if (!sessionId) {
    const visible = await visibleActivityUserIds(candidates, viewerId);
    for (const userId of self) visible.add(userId);
    return visible;
  }
  const visible = (
    await sessionsVisibleUserIds([{ session: await loadSessionBoardSource(sessionId), userIds: candidates }], viewerId)
  )[0];
  for (const userId of self) visible.add(userId);
  const unnamed = candidates.filter((userId) => !visible.has(userId));
  if (unnamed.length === 0) return visible;
  for (const userId of await sessionCoMemberIds(unnamed, viewerId, sessionId)) visible.add(userId);
  return visible;
}

/**
 * `sessionVisibleUserIds` for many sessions at once, in the order given: each
 * row's climbers that session's own surfaces name to the viewer (their
 * account and board allow it, they are the viewer, or they are a fellow member
 * of that session). One board resolution and one query for every row, plus one
 * membership read when someone is left unnamed.
 */
export async function sessionsOwnSurfaceVisibleUserIds(rows: SessionRows, viewerId: ViewerId): Promise<Set<string>[]> {
  const visible = await sessionsVisibleUserIds(rows, viewerId);
  const unnamed = rows.map(({ session, userIds }, rowIndex) => {
    const candidates = distinctIds(userIds);
    if (viewerId && candidates.includes(viewerId)) visible[rowIndex].add(viewerId);
    return { sessionId: session.id, userIds: candidates.filter((userId) => !visible[rowIndex].has(userId)) };
  });
  if (unnamed.every(({ userIds }) => userIds.length === 0)) return visible;
  const coMembers = await sessionsCoMemberIds(unnamed, viewerId);
  coMembers.forEach((members, rowIndex) => {
    for (const userId of members) visible[rowIndex].add(userId);
  });
  return visible;
}

const pendingSessionVisibility: PendingLookups = new Map();
/**
 * `sessionVisibleUserIds` for the GraphQL field projections (`ClimbQueueItem`,
 * `SessionUser`), which graphql-js resolves one item and one field at a time.
 * Every lookup for the same viewer and session in one pass (all the items of
 * one queue or roster) shares one board resolution and one query, plus one
 * membership read when someone is left unnamed (`batchedLookup`).
 */
export function batchedSessionVisibleUserIds(
  userIds: readonly (string | null | undefined)[],
  viewerId: ViewerId,
  sessionId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  return batchedLookup(
    pendingSessionVisibility,
    JSON.stringify([viewerId ?? null, sessionId ?? null]),
    userIds,
    (ids) => sessionVisibleUserIds(ids, viewerId, sessionId),
  );
}

const pendingSessionCoMembers: PendingLookups = new Map();
/** `sessionCoMemberIds` for GraphQL field projections, one read per viewer and session per pass. */
export function batchedSessionCoMemberIds(
  userIds: readonly (string | null | undefined)[],
  viewerId: ViewerId,
  sessionId: string,
): Promise<ReadonlySet<string>> {
  if (!viewerId) return Promise.resolve(new Set());
  return batchedLookup(pendingSessionCoMembers, JSON.stringify([viewerId, sessionId]), userIds, (ids) =>
    sessionCoMemberIds(ids, viewerId, sessionId),
  );
}

/**
 * The roster names a climber by their account, except that a climber who stays
 * anonymous on boards they don't own is anonymous in a session on such a board,
 * to everyone but themselves and the session's other members. Opaque
 * per-session ids either way. Pass
 * `visibleUserIds` (`sessionVisibleUserIds`) when it is already known.
 */
export async function redactSessionUsers(
  users: readonly SessionUser[],
  viewerId: ViewerId,
  sessionId: string,
  visibleUserIds?: ReadonlySet<string>,
): Promise<SessionUser[]> {
  const visible =
    visibleUserIds ??
    (await sessionVisibleUserIds(
      users.map((user) => user.userId),
      viewerId,
      sessionId,
    ));
  return users.map((user) => {
    const id = user.userId ? sessionParticipantId(sessionId, user.userId) : user.id;
    const projected =
      user.userId && !visible.has(user.userId)
        ? { ...user, id, userId: null, username: '', avatarUrl: undefined }
        : { ...user, id };
    rosterSourceSessions.set(projected, sessionId);
    return projected;
  });
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

// Publication/ownership checks below use the shared two-valued predicate.
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
        ownedOrPublicClimbCondition(boardClimbs, viewerId),
        sprayClimbVisibilityCondition(
          { boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId },
          viewerId,
          wallUuid,
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

/** Every climber a queue item names: who added it and who ticked it. */
export function queueItemUserIds(items: readonly ClimbQueueItem[]): (string | null | undefined)[] {
  return items.flatMap((item) => [item.addedByUser?.id ?? item.addedBy, ...(item.tickedBy ?? [])]);
}

/**
 * `sessionId` is the session the item belongs to (null outside one); pass the
 * precomputed `visibleUserIds` (`sessionVisibleUserIds` over `queueItemUserIds`)
 * when redacting a whole queue.
 */
export async function redactQueueItem(
  item: ClimbQueueItem,
  viewerId: ViewerId,
  sessionId: string | null | undefined,
  visibleUserIds?: ReadonlySet<string>,
): Promise<ClimbQueueItem> {
  const visible = visibleUserIds ?? (await sessionVisibleUserIds(queueItemUserIds([item]), viewerId, sessionId));
  const projected = { ...redactQueueAttribution(item, visible), climb: await redactQueueClimb(item.climb, viewerId) };
  queueSourceSessions.set(projected, sessionId ?? null);
  return projected;
}

/** Who added and ticked a queue item, kept only for the climbers in `visibleUserIds`. */
export function redactQueueAttribution(item: ClimbQueueItem, visibleUserIds: ReadonlySet<string>): ClimbQueueItem {
  const userId = item.addedByUser?.id ?? item.addedBy;
  const showAuthor = !!userId && visibleUserIds.has(userId);
  return {
    ...item,
    addedBy: showAuthor ? item.addedBy : undefined,
    addedByUser: showAuthor ? item.addedByUser : undefined,
    tickedBy: (item.tickedBy ?? []).filter((tickerId) => visibleUserIds.has(tickerId)),
  };
}

/**
 * Preserve chronology while checking current item and author privacy.
 * `boardId` is the board the feed is for. A verified presence link opens only
 * its own spray layout; other callers retain the no-link reading by omitting
 * wallUuid.
 */
export async function redactBoardClimbs(
  climbs: readonly BoardPresenceClimb[],
  viewerId: ViewerId,
  boardId: number,
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
              ownedOrPublicClimbCondition(boardClimbs, viewerId),
              sprayClimbVisibilityCondition(
                { boardType: boardClimbs.boardType, layoutId: boardClimbs.layoutId },
                viewerId,
                wallUuid,
              ),
            ),
          );
  const readableUuids = new Set(readableClimbs.map((climb) => climb.uuid));

  // The sender's account privacy decides attribution, whatever session (or
  // none) the send was in and however old the history event is, and a sender
  // who stays anonymous on boards they don't own is anonymous here when this
  // board is not theirs. One query for every sender on the page.
  const visibleSenders = await visibleActivityUserIds(
    climbs.map((climb) => climb.sentByUserId),
    viewerId,
    { boardId },
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

/** Board membership can release default identity, never an explicit tick restriction. */
export async function canViewBoardTickOverride(userId: string, tickUuid: string, viewerId: ViewerId): Promise<boolean> {
  if (viewerId === userId) return true;
  const [policy] = await db
    .select({ ownerId: contentPrivacy.ownerId })
    .from(contentPrivacy)
    .where(
      and(
        eq(contentPrivacy.entityType, 'tick'),
        eq(contentPrivacy.entityId, tickUuid),
        eq(contentPrivacy.ownerId, userId),
      ),
    )
    .limit(1);
  return !policy || canViewContent(viewerId, 'tick', tickUuid, userId);
}

/** Current member visibility names only this board's actor; item visibility remains the fallback. */
export async function canViewBoardHardestSendIdentity(
  send: BoardPresenceHardestSend,
  viewerId: ViewerId,
  boardId: number,
): Promise<boolean> {
  const userId = send.sentByUserId;
  if (!userId) return false;
  if (userId === viewerId) return true;
  if (!send.tickUuid) return false;
  if (!(await canViewBoardTickOverride(userId, send.tickUuid, viewerId))) return false;
  if ((await visibleActivityUserIds([userId], viewerId, { boardId })).has(userId)) return true;
  if ((await anonymousOnBoardUserIds([userId], { boardId }, viewerId)).has(userId)) return false;
  return canViewActivityIdentity(userId, viewerId, { entityType: 'tick', entityId: send.tickUuid });
}

export async function redactBoardStats(
  stats: BoardPresenceStats,
  viewerId: string | null | undefined,
  boardId: number,
  wallUuid?: string | null,
): Promise<BoardPresenceStats> {
  const hardest = stats.hardestSend;
  if (!hardest) return stats;
  // Featured only when the viewer may see the climb in a list: published and
  // listed whoever set it, or their own, and not on a wall they cannot see (a
  // held link opens its own wall). A draft or an unlisted climb is named to its
  // owner alone, and the board sheet and kiosk are browse surfaces. Cached
  // metadata may predate a draft, unlisting or wall-policy change, so a known
  // catalog row is checked now, by the same gate as history. Aggregate grades
  // and counts above remain unchanged.
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
  const showIdentity = await canViewBoardHardestSendIdentity(visibleHardest, viewerId, boardId);
  const projected = showIdentity
    ? { ...visibleHardest }
    : { ...visibleHardest, sentByUserId: null, sentByDisplayName: null, sentByAvatarUrl: null };
  hardestSendSourceBoards.set(projected, boardId);
  return { ...stats, hardestSend: projected };
}

/**
 * The Bluetooth holder is named by their own account privacy, session or not,
 * and stays anonymous on a board they don't own when they chose to.
 */
export async function redactBoardHolder(
  holder: BoardConnectionHolder | null,
  viewerId: string | null | undefined,
  boardId: number,
): Promise<BoardConnectionHolder | null> {
  if (!holder) return null;
  if (
    holder.userId &&
    (holder.userId === viewerId ||
      (await visibleActivityUserIds([holder.userId], viewerId, { boardId })).has(holder.userId))
  )
    return holder;
  return { ...holder, userId: null, displayName: null, avatarUrl: null };
}

export async function redactBoardEvent(
  event: BoardPresenceEvent,
  viewerId: string | null | undefined,
  boardId: number,
  wallUuid?: string | null,
): Promise<BoardPresenceEvent> {
  switch (event.__typename) {
    case 'BoardClimbSet':
      return { ...event, climb: (await redactBoardClimbs([event.climb], viewerId, boardId, wallUuid))[0] };
    case 'BoardHistoryUpdated':
      return { ...event, climbs: await redactBoardClimbs(event.climbs, viewerId, boardId, wallUuid) };
    case 'BoardStatsUpdated':
      return { ...event, stats: await redactBoardStats(event.stats, viewerId, boardId, wallUuid) };
    case 'BoardConnectionChanged': {
      return { ...event, holder: await redactBoardHolder(event.holder, viewerId, boardId) };
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
