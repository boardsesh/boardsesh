import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type {
  LiveSession,
  LiveSessionBoard,
  LiveSessionClimb,
  LiveSessionReason,
  LiveSessionUser,
  SessionUser,
} from '@boardsesh/shared-schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { pubsub } from '../pubsub/index';
import { roomManager } from './room-manager';
import { toBoardQueuePreviewItem } from './board-queue-preview';
import { isRowAnonReadable } from '../graphql/resolvers/board-presence/shared';
import { isSprayBoardType, sprayBoardRowIsReadable } from '../graphql/resolvers/climbs/spray-read-access';
import {
  consensusGradeJoinCondition,
  consensusGradeTable,
  difficultyNameWithFallbackExpr,
} from '../graphql/resolvers/shared/sql-expressions';
import { logger } from '../utils/logger';

/**
 * Live sessions: who is climbing right now, for Home's "Climbing now" rail
 * (`followedLiveSessions`) and a board's presence sheet (`boardLiveSessions`).
 *
 * The pipeline, in order — each stage only sees what the previous one kept:
 *
 * 1. **Candidates** (SQL): explicit, active, not ended, touched in the last 4h,
 *    newest 50. The arm filters are pushed into the WHERE so the cap never
 *    drops a relevant session behind 50 unrelated ones, and so a private session
 *    the viewer has no row in never leaves Postgres.
 * 2. **Liveness** (Redis, no rosters): somebody connected, or a dormant session
 *    touched in the last 20 min whose Redis key still exists.
 * 3. **Board resolution**, then in board mode only the sessions on that board
 *    go on.
 * 4. **Rosters**, for the survivors only. Visibility (public, or the viewer is
 *    the creator / on the live roster) and the social arm need them.
 * 5. **Arms**: followed creator or followed climber on the live roster, the
 *    session's resolved board followed / selected, or the viewer's own session.
 * 6. **Sort + limit**, then enrichment (profiles, tick stats, current climb) on
 *    the page only.
 *
 * See the "Live sessions" section of docs/websocket-implementation.md.
 */

export const LIVE_SESSION_CANDIDATE_WINDOW_MS = 4 * 60 * 60 * 1000;
export const LIVE_SESSION_CANDIDATE_CAP = 50;
/** A session with nobody connected still counts when touched this recently and its Redis key survives. */
export const LIVE_SESSION_DORMANT_GRACE_MS = 20 * 60 * 1000;
export const LIVE_SESSION_ROSTER_CAP = 5;
export const FOLLOWED_LIVE_SESSIONS_DEFAULT_LIMIT = 10;
export const FOLLOWED_LIVE_SESSIONS_MAX_LIMIT = 20;
/** A board rarely has more than one or two sessions; this only bounds enrichment. */
export const BOARD_LIVE_SESSIONS_LIMIT = 20;

const boardSessions = dbSchema.boardSessions;

const candidateColumns = {
  id: boardSessions.id,
  boardPath: boardSessions.boardPath,
  boardId: boardSessions.boardId,
  createdByUserId: boardSessions.createdByUserId,
  name: boardSessions.name,
  goal: boardSessions.goal,
  color: boardSessions.color,
  startedAt: boardSessions.startedAt,
  createdAt: boardSessions.createdAt,
  lastActivity: boardSessions.lastActivity,
  isPublic: boardSessions.isPublic,
};

type CandidateSession = {
  id: string;
  boardPath: string | null;
  boardId: number | null;
  createdByUserId: string | null;
  name: string | null;
  goal: string | null;
  color: string | null;
  startedAt: Date | null;
  createdAt: Date;
  lastActivity: Date;
  isPublic: boolean;
};

type BoardRow = {
  id: number;
  uuid: string;
  name: string;
  slug: string;
  boardType: string;
  layoutId: number;
  angle: number;
  ownerId: string;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  deletedAt: Date | null;
  gymName: string | null;
};

type ArmBoard = { id: number; slug: string };

// ---------------------------------------------------------------------------
// Board paths
// ---------------------------------------------------------------------------

export type ParsedSessionBoardPath = {
  /** `/b/<slug>/<angle>` — gym and LED-less boards */
  slug: string | null;
  /** `/<boardType>/<layout>/<size>/<sets>/<angle>` */
  boardType: string | null;
  angle: number | null;
};

function parseAngle(segment: string | undefined): number | null {
  if (!segment || !/^-?\d{1,2}$/.test(segment)) return null;
  const angle = Number(segment);
  return angle >= -90 && angle <= 90 ? angle : null;
}

/**
 * Pull what a board path says about its board. Tolerates a missing leading
 * slash, which older rows (and tests) carry.
 */
export function parseSessionBoardPath(boardPath: string | null | undefined): ParsedSessionBoardPath {
  const parts = (boardPath ?? '').replace(/^\/+/, '').split('/');
  if (parts[0] === 'b') {
    return { slug: parts[1] || null, boardType: null, angle: parseAngle(parts[2]) };
  }
  if (parts.length >= 2 && /^[a-z][a-z0-9_-]*$/.test(parts[0])) {
    return { slug: null, boardType: parts[0], angle: parseAngle(parts[4]) };
  }
  return { slug: null, boardType: null, angle: null };
}

// ---------------------------------------------------------------------------
// Board resolution
// ---------------------------------------------------------------------------

function toBoardId(value: number | string | null | undefined): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The board each session is on right now, most specific evidence first:
 *
 * 1. its newest `boardsesh_ticks` row with a board,
 * 2. the `board_sessions.board_id` column,
 * 3. a `/b/<slug>/…` board path → `user_boards.slug`,
 * 4. the Redis session→board binding stamped by `reportBoardClimb`.
 *
 * `board_climb_events` is deliberately absent: it has a `session_id` column,
 * but `reportBoardClimb` writes null there today, so it cannot place a session.
 * Once that write carries the session, its newest event belongs first here and
 * in `boardArmPrefilter`.
 *
 * Two batched SQL reads regardless of how many sessions come in; Redis is only
 * asked about sessions neither resolved.
 */
export async function resolveLiveSessionBoards(
  sessions: ReadonlyArray<{ id: string; boardId: number | null; boardPath: string | null }>,
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  if (sessions.length === 0) return resolved;

  const sessionIds = sessions.map((session) => session.id);
  const slugBySessionId = new Map<string, string>();
  for (const session of sessions) {
    const { slug } = parseSessionBoardPath(session.boardPath);
    if (slug) slugBySessionId.set(session.id, slug);
  }
  const slugs = [...new Set(slugBySessionId.values())];

  const ticks = dbSchema.boardseshTicks;
  const [tickRows, slugRows] = await Promise.all([
    db
      .selectDistinctOn([ticks.sessionId], { sessionId: ticks.sessionId, boardId: ticks.boardId })
      .from(ticks)
      .where(and(inArray(ticks.sessionId, sessionIds), isNotNull(ticks.boardId)))
      .orderBy(ticks.sessionId, desc(ticks.climbedAt), desc(ticks.id)),
    slugs.length > 0
      ? db
          .select({ id: dbSchema.userBoards.id, slug: dbSchema.userBoards.slug })
          .from(dbSchema.userBoards)
          .where(and(inArray(dbSchema.userBoards.slug, slugs), isNull(dbSchema.userBoards.deletedAt)))
      : Promise.resolve([]),
  ]);

  const tickBoardBySession = new Map<string, number>();
  for (const row of tickRows) {
    const boardId = toBoardId(row.boardId);
    if (row.sessionId && boardId) tickBoardBySession.set(row.sessionId, boardId);
  }
  const boardIdBySlug = new Map(slugRows.map((row) => [row.slug, Number(row.id)]));

  const unresolved: string[] = [];
  for (const session of sessions) {
    const slug = slugBySessionId.get(session.id);
    const boardId =
      tickBoardBySession.get(session.id) ?? toBoardId(session.boardId) ?? (slug ? boardIdBySlug.get(slug) : undefined);
    if (boardId) {
      resolved.set(session.id, boardId);
    } else {
      unresolved.push(session.id);
    }
  }

  const redisBindings = await Promise.all(
    unresolved.map(async (sessionId) => {
      try {
        return [sessionId, toBoardId(await pubsub.getSessionBoard(sessionId))] as const;
      } catch (error) {
        logger.warn(`[live-sessions] session→board binding read failed for ${sessionId}: ${String(error)}`);
        return [sessionId, null] as const;
      }
    }),
  );
  for (const [sessionId, boardId] of redisBindings) {
    if (boardId) resolved.set(sessionId, boardId);
  }

  return resolved;
}

async function loadBoardRows(boardIds: readonly number[]): Promise<Map<number, BoardRow>> {
  if (boardIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      name: dbSchema.userBoards.name,
      slug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      angle: dbSchema.userBoards.angle,
      ownerId: dbSchema.userBoards.ownerId,
      isPublic: dbSchema.userBoards.isPublic,
      isUnlisted: dbSchema.userBoards.isUnlisted,
      hideLocation: dbSchema.userBoards.hideLocation,
      deletedAt: dbSchema.userBoards.deletedAt,
      gymName: dbSchema.gyms.name,
    })
    .from(dbSchema.userBoards)
    .leftJoin(dbSchema.gyms, and(eq(dbSchema.gyms.id, dbSchema.userBoards.gymId), isNull(dbSchema.gyms.deletedAt)))
    .where(inArray(dbSchema.userBoards.id, [...new Set(boardIds)]));
  return new Map(rows.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
}

/**
 * The board as this viewer may see it, or null. Never leaks a board the viewer
 * could not otherwise find:
 *
 * - it must be live (not deleted) and anonymously readable (public, or a
 *   system-shared board — the one anon rule, `isRowAnonReadable`), or owned;
 * - an UNLISTED board is reachable by link, never enumerated, so it is only
 *   named to a viewer who already holds it: they follow it, selected it, or
 *   are reading that board's own sheet (`heldBoardIds`). Same rule as the tick
 *   feeds' `canShowBoard`;
 * - a spray wall additionally needs the wall's own enumerable rule, since a
 *   public-flagged wall can still be admin-hidden or scoped to a gym.
 */
async function toVisibleBoard(
  row: BoardRow | undefined,
  viewerId: string | null,
  heldBoardIds: ReadonlySet<number>,
): Promise<LiveSessionBoard | null> {
  if (!row || row.deletedAt) return null;
  const isOwner = viewerId !== null && row.ownerId === viewerId;
  if (!isOwner) {
    if (!isRowAnonReadable(row)) return null;
    if (row.isUnlisted && !heldBoardIds.has(row.id)) return null;
    if (isSprayBoardType(row.boardType) && !(await sprayBoardRowIsReadable(row, viewerId, 'enumerable'))) {
      return null;
    }
  }
  return {
    uuid: row.uuid,
    name: row.name,
    slug: row.slug,
    boardType: row.boardType,
    gymName: row.hideLocation && !isOwner ? null : row.gymName,
  };
}

/**
 * Whether a board may drive the board arm for this viewer. A spray wall that
 * went private, lost the viewer's gym membership or was hidden by an admin
 * stops listing its sessions even though the follow row survives. Uses the
 * enumerable rule for every spray wall: the capability form's unlisted
 * exemption does not check the admin-hidden flag.
 */
async function viewerMayUseBoardArm(
  row: { boardType: string; layoutId: number; ownerId: string },
  viewerId: string,
): Promise<boolean> {
  if (row.ownerId === viewerId || !isSprayBoardType(row.boardType)) return true;
  return sprayBoardRowIsReadable(row, viewerId, 'enumerable');
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function candidateBase(now: Date): SQL {
  return and(
    eq(boardSessions.origin, 'explicit'),
    eq(boardSessions.status, 'active'),
    isNull(boardSessions.endedAt),
    gt(boardSessions.lastActivity, windowStart(now)),
  ) as SQL;
}

function windowStart(now: Date): Date {
  return new Date(now.getTime() - LIVE_SESSION_CANDIDATE_WINDOW_MS);
}

function participantRowExists(userCondition: SQL): SQL {
  const participants = dbSchema.boardSessionParticipants;
  return exists(
    db
      .select({ one: sql`1` })
      .from(participants)
      .where(and(eq(participants.sessionId, boardSessions.id), userCondition)),
  );
}

/**
 * The SQL half of the visibility rule. A private session only passes when the
 * viewer created it or has a participant row; the live roster confirms the
 * latter afterwards.
 */
function visibilityPrefilter(viewerId: string | null): SQL {
  if (!viewerId) return eq(boardSessions.isPublic, true);
  return or(
    eq(boardSessions.isPublic, true),
    eq(boardSessions.createdByUserId, viewerId),
    participantRowExists(eq(dbSchema.boardSessionParticipants.userId, viewerId)),
  ) as SQL;
}

/**
 * Every durable or live way a session can point at one of `boards`. Mirrors
 * the resolution order in `resolveLiveSessionBoards` (which still decides the
 * final board — this only keeps the 50-row cap honest).
 */
function boardArmPrefilter(boards: readonly ArmBoard[], redisBoundSessionIds: readonly string[]): SQL | undefined {
  if (boards.length === 0) return undefined;
  const boardIds = boards.map((board) => board.id);
  const slugs = [...new Set(boards.map((board) => board.slug))];
  const ticks = dbSchema.boardseshTicks;
  const trimmedPath = sql`ltrim(${boardSessions.boardPath}, '/')`;
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(ticks)
        .where(and(eq(ticks.sessionId, boardSessions.id), inArray(ticks.boardId, boardIds))),
    ),
    inArray(boardSessions.boardId, boardIds),
    and(like(trimmedPath, 'b/%'), inArray(sql`split_part(${trimmedPath}, '/', 2)`, slugs)),
    redisBoundSessionIds.length > 0 ? inArray(boardSessions.id, [...redisBoundSessionIds]) : undefined,
  );
}

/** Sessions the Redis board→session bindings say are on these boards right now. */
async function readBoardBoundSessionIds(boardIds: readonly number[]): Promise<string[]> {
  const sessionIds = await Promise.all(
    boardIds.map(async (boardId) => {
      try {
        return await pubsub.getBoardSession(String(boardId));
      } catch (error) {
        logger.warn(`[live-sessions] board→session binding read failed for board ${boardId}: ${String(error)}`);
        return null;
      }
    }),
  );
  return [...new Set(sessionIds.filter((sessionId): sessionId is string => Boolean(sessionId)))];
}

async function loadCandidates(where: SQL): Promise<CandidateSession[]> {
  const rows = await db
    .select(candidateColumns)
    .from(boardSessions)
    .where(where)
    .orderBy(desc(boardSessions.lastActivity), desc(boardSessions.id))
    .limit(LIVE_SESSION_CANDIDATE_CAP);
  return rows.map((row) => ({ ...row, boardId: toBoardId(row.boardId) }));
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

async function loadFollowedAmong(viewerId: string, userIds: readonly string[]): Promise<Set<string>> {
  const candidates = [...new Set(userIds)].filter((userId) => userId !== viewerId);
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ userId: dbSchema.userFollows.followingId })
    .from(dbSchema.userFollows)
    .where(and(eq(dbSchema.userFollows.followerId, viewerId), inArray(dbSchema.userFollows.followingId, candidates)));
  return new Set(rows.map((row) => row.userId));
}

/** Display identity from the same source the session feed uses: profile first, account second. */
async function loadProfiles(userIds: readonly string[]): Promise<Map<string, LiveSessionUser>> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: dbSchema.users.id,
      displayName: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
      avatarUrl: sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
    .where(inArray(dbSchema.users.id, uniqueUserIds));
  return new Map(rows.map((row) => [row.userId, row]));
}

type SessionTickStats = { sendCount: number; flashCount: number; hardestSendGrade: string | null };

/**
 * Sends, flashes and the hardest send's grade for every session in ONE grouped
 * query. Sends rank like the session feed's `fetchHardestSendsBatch`: the
 * tick's own difficulty, falling back to the climb's consensus grade at that
 * angle (alias-resolved), newest first on ties. The name is the board's own
 * grade name — for the logged difficulty, else for the consensus grade
 * (`difficultyNameWithFallbackExpr`, as the tick feeds use) — and only falls
 * back to the shared 10–33 labels when the board's grade table has no row.
 */
async function loadTickStats(sessionIds: readonly string[]): Promise<Map<string, SessionTickStats>> {
  if (sessionIds.length === 0) return new Map();
  const ticks = dbSchema.boardseshTicks;
  const aliases = dbSchema.boardClimbAliases;
  const climbStats = dbSchema.boardClimbStats;
  const grades = dbSchema.boardDifficultyGrades;
  const isSend = sql`${ticks.status} IN ('flash', 'send')`;
  const effectiveDifficulty = sql`COALESCE(${ticks.difficulty}, ROUND(${climbStats.displayDifficulty})::int)`;
  const hardestOrder = sql`COALESCE(${effectiveDifficulty}, -1) DESC, ${ticks.climbedAt} DESC, ${ticks.id} DESC`;

  const rows = await db
    .select({
      sessionId: ticks.sessionId,
      sendCount: sql<number>`(COUNT(*) FILTER (WHERE ${isSend}))::int`,
      flashCount: sql<number>`(COUNT(*) FILTER (WHERE ${ticks.status} = 'flash'))::int`,
      hardestDifficulty: sql<
        number | null
      >`(ARRAY_AGG(${effectiveDifficulty} ORDER BY ${hardestOrder}) FILTER (WHERE ${isSend}))[1]`,
      hardestGradeName: sql<
        string | null
      >`(ARRAY_AGG(${difficultyNameWithFallbackExpr} ORDER BY ${hardestOrder}) FILTER (WHERE ${isSend}))[1]`,
    })
    .from(ticks)
    .leftJoin(aliases, and(eq(aliases.boardType, ticks.boardType), eq(aliases.aliasUuid, ticks.climbUuid)))
    .leftJoin(
      climbStats,
      and(
        eq(climbStats.climbUuid, sql`COALESCE(${aliases.canonicalUuid}, ${ticks.climbUuid})`),
        eq(climbStats.boardType, ticks.boardType),
        eq(climbStats.angle, ticks.angle),
      ),
    )
    .leftJoin(grades, and(eq(grades.difficulty, ticks.difficulty), eq(grades.boardType, ticks.boardType)))
    .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
    .where(inArray(ticks.sessionId, [...sessionIds]))
    .groupBy(ticks.sessionId);

  const stats = new Map<string, SessionTickStats>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const hardestDifficulty = row.hardestDifficulty == null ? null : Number(row.hardestDifficulty);
    stats.set(row.sessionId, {
      sendCount: Number(row.sendCount),
      flashCount: Number(row.flashCount),
      hardestSendGrade:
        row.hardestGradeName || (hardestDifficulty != null ? getGradeLabel(hardestDifficulty) : null) || null,
    });
  }
  return stats;
}

/**
 * The climb on the wall, through the board queue preview's redaction
 * (`toBoardQueuePreviewItem`: catalog fields only, never who added it).
 */
async function loadCurrentClimb(sessionId: string): Promise<LiveSessionClimb | null> {
  try {
    const queueState = await roomManager.getQueueState(sessionId);
    if (!queueState.currentClimbQueueItem) return null;
    const redacted = toBoardQueuePreviewItem(queueState.currentClimbQueueItem);
    return redacted.name ? { name: redacted.name, grade: redacted.grade ?? null } : null;
  } catch (error) {
    logger.warn(`[live-sessions] queue state read failed for ${sessionId}: ${String(error)}`);
    return null;
  }
}

async function loadRoster(sessionId: string): Promise<SessionUser[]> {
  try {
    return await roomManager.getSessionUsers(sessionId);
  } catch (error) {
    logger.warn(`[live-sessions] roster read failed for ${sessionId}: ${String(error)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// The shared pipeline
// ---------------------------------------------------------------------------

type BuildLiveSessionsParams = {
  viewerId: string | null;
  candidates: CandidateSession[];
  now: Date;
  limit: number;
  /** Board-arm reasons for a session's resolved board (undefined when unresolved). */
  boardReasons: (boardId: number | undefined) => LiveSessionReason[];
  /** Boards the viewer already holds (follows, selected, or is reading the sheet of). */
  heldBoardIds: ReadonlySet<number>;
  /**
   * `home`: listed when any reason holds, or the session is the viewer's own.
   * `board`: listed only when the board arm matched (SELECTED_BOARD).
   */
  mode: 'home' | 'board';
};

type ListedSession = {
  candidate: CandidateSession;
  roster: SessionUser[];
  viewerIsMember: boolean;
  followedParticipantIds: string[];
  boardId: number | undefined;
  reasons: LiveSessionReason[];
};

function isLive(candidate: CandidateSession, connectionCount: number, redisKeyExists: boolean, now: Date): boolean {
  if (connectionCount > 0) return true;
  return redisKeyExists && candidate.lastActivity.getTime() >= now.getTime() - LIVE_SESSION_DORMANT_GRACE_MS;
}

function compareListed(a: ListedSession, b: ListedSession): number {
  return (
    Number(b.viewerIsMember) - Number(a.viewerIsMember) ||
    Number(b.followedParticipantIds.length > 0) - Number(a.followedParticipantIds.length > 0) ||
    b.roster.length - a.roster.length ||
    b.candidate.lastActivity.getTime() - a.candidate.lastActivity.getTime() ||
    a.candidate.id.localeCompare(b.candidate.id)
  );
}

function signedInUserIds(roster: SessionUser[]): string[] {
  return [...new Set(roster.map((member) => member.userId).filter((userId): userId is string => Boolean(userId)))];
}

async function buildLiveSessions(params: BuildLiveSessionsParams): Promise<LiveSession[]> {
  const { viewerId, candidates, now, limit, boardReasons, heldBoardIds, mode } = params;
  if (candidates.length === 0) return [];

  // Liveness from connection counts and Redis key existence only — no roster
  // reads for the (usually many) candidates nobody is connected to.
  const connectionLiveness = await roomManager.getSessionConnectionLiveness(candidates.map(({ id }) => id));
  const live = candidates.filter((candidate) => {
    const liveness = connectionLiveness.get(candidate.id);
    return liveness !== undefined && isLive(candidate, liveness.liveConnectionCount, liveness.redisKeyExists, now);
  });
  if (live.length === 0) return [];

  const boardBySession = await resolveLiveSessionBoards(live);
  // Board mode never lists a session on another board, so it never pays for
  // that session's roster.
  const shortlist =
    mode === 'board'
      ? live.filter((candidate) => boardReasons(boardBySession.get(candidate.id)).includes('SELECTED_BOARD'))
      : live;
  if (shortlist.length === 0) return [];

  const rosters = await Promise.all(shortlist.map((candidate) => loadRoster(candidate.id)));
  const withRosters = shortlist.flatMap((candidate, index) => {
    const roster = rosters[index];
    const viewerIsMember =
      viewerId !== null &&
      (candidate.createdByUserId === viewerId || roster.some((member) => member.userId === viewerId));
    // Visibility: a private session is pruned for everyone not in it.
    if (!candidate.isPublic && !viewerIsMember) return [];
    return [{ candidate, roster, viewerIsMember }];
  });
  if (withRosters.length === 0) return [];

  const followed = viewerId
    ? await loadFollowedAmong(
        viewerId,
        withRosters.flatMap(({ candidate, roster }) => [
          ...signedInUserIds(roster),
          ...(candidate.createdByUserId ? [candidate.createdByUserId] : []),
        ]),
      )
    : new Set<string>();

  const listed: ListedSession[] = [];
  for (const entry of withRosters) {
    const { candidate, roster, viewerIsMember } = entry;
    // Only a followed climber who is actually on the live roster counts — a
    // participant row is permanent and outlives leaving.
    const followedParticipantIds = signedInUserIds(roster).filter((userId) => followed.has(userId));
    const followsCreator = candidate.createdByUserId !== null && followed.has(candidate.createdByUserId);
    const boardId = boardBySession.get(candidate.id);
    const matchedBoardReasons = boardReasons(boardId);

    const reasons: LiveSessionReason[] = [];
    if (followsCreator || followedParticipantIds.length > 0) reasons.push('FOLLOWING_USER');
    reasons.push(...matchedBoardReasons);

    const listedHere =
      mode === 'board' ? matchedBoardReasons.includes('SELECTED_BOARD') : reasons.length > 0 || viewerIsMember;
    if (!listedHere) continue;

    listed.push({ ...entry, followedParticipantIds, boardId, reasons });
  }

  const page = listed.sort(compareListed).slice(0, limit);
  if (page.length === 0) return [];

  const [profiles, tickStats, boardRows] = await Promise.all([
    loadProfiles(
      page.flatMap(({ candidate, roster }) => [
        ...signedInUserIds(roster),
        ...(candidate.createdByUserId ? [candidate.createdByUserId] : []),
      ]),
    ),
    loadTickStats(page.map(({ candidate }) => candidate.id)),
    loadBoardRows(page.flatMap(({ boardId }) => (boardId ? [boardId] : []))),
  ]);

  return Promise.all(
    page.map(async (entry): Promise<LiveSession> => {
      const { candidate, roster, followedParticipantIds } = entry;
      const boardRow = entry.boardId ? boardRows.get(entry.boardId) : undefined;
      const parsedPath = parseSessionBoardPath(candidate.boardPath);
      const boardType = parsedPath.boardType ?? boardRow?.boardType ?? null;
      const stats = tickStats.get(candidate.id);

      const toUser = (userId: string, member?: SessionUser): LiveSessionUser => {
        const profile = profiles.get(userId);
        return {
          userId,
          displayName: profile?.displayName ?? member?.username ?? null,
          avatarUrl: profile?.avatarUrl ?? member?.avatarUrl ?? null,
        };
      };

      // Signed-in climbers only (an anonymous connection has no user to show),
      // one entry per climber, followed climbers first, capped.
      const seen = new Set<string>();
      const members = roster.filter((member): member is SessionUser & { userId: string } => {
        if (!member.userId || seen.has(member.userId)) return false;
        seen.add(member.userId);
        return true;
      });
      const followedSet = new Set(followedParticipantIds);
      const participants = [
        ...members.filter((member) => followedSet.has(member.userId)),
        ...members.filter((member) => !followedSet.has(member.userId)),
      ]
        .slice(0, LIVE_SESSION_ROSTER_CAP)
        .map((member) => toUser(member.userId, member));

      const creatorId = candidate.createdByUserId;
      const [board, currentClimb] = await Promise.all([
        toVisibleBoard(boardRow, viewerId, heldBoardIds),
        // Public sessions only, and only when the board type is known and is
        // not a spray wall: a spray wall's climbs stay private to the wall even
        // when the session is public, and an unknown type could be one.
        candidate.isPublic && boardType !== null && !isSprayBoardType(boardType)
          ? loadCurrentClimb(candidate.id)
          : Promise.resolve(null),
      ]);

      return {
        sessionId: candidate.id,
        name: candidate.name,
        goal: candidate.goal,
        color: candidate.color,
        startedAt: (candidate.startedAt ?? candidate.createdAt).toISOString(),
        lastActivity: candidate.lastActivity.toISOString(),
        host: creatorId
          ? toUser(
              creatorId,
              roster.find((member) => member.userId === creatorId),
            )
          : null,
        participants,
        // The live roster is deduped by participant, so its length is the
        // display head-count (anonymous connections included).
        participantCount: roster.length,
        followedParticipantIds,
        viewerIsMember: entry.viewerIsMember,
        isPublic: candidate.isPublic,
        board,
        boardType,
        angle: parsedPath.angle ?? boardRow?.angle ?? null,
        sendCount: stats?.sendCount ?? 0,
        flashCount: stats?.flashCount ?? 0,
        hardestSendGrade: stats?.hardestSendGrade ?? null,
        currentClimb,
        reasons: entry.reasons,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function loadFollowedBoards(viewerId: string): Promise<ArmBoard[]> {
  const rows = await db
    .select({
      id: dbSchema.userBoards.id,
      slug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      ownerId: dbSchema.userBoards.ownerId,
    })
    .from(dbSchema.boardFollows)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.boardFollows.boardUuid))
    .where(and(eq(dbSchema.boardFollows.userId, viewerId), isNull(dbSchema.userBoards.deletedAt)));
  const usable = await Promise.all(rows.map((row) => viewerMayUseBoardArm(row, viewerId)));
  return rows.filter((_, index) => usable[index]).map((row) => ({ id: Number(row.id), slug: row.slug }));
}

/**
 * The board behind `boardUuid`, or null when it does not exist or the viewer
 * may not reach it. A spray wall the viewer cannot read (including an
 * admin-hidden one) is answered exactly like a missing board, so the response
 * is no oracle.
 */
async function loadSelectedBoard(boardUuid: string, viewerId: string): Promise<ArmBoard | null> {
  const [row] = await db
    .select({
      id: dbSchema.userBoards.id,
      slug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      ownerId: dbSchema.userBoards.ownerId,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (!row || !(await viewerMayUseBoardArm(row, viewerId))) return null;
  return { id: Number(row.id), slug: row.slug };
}

/**
 * Home's "Climbing now" rail: live sessions started or joined by people the
 * viewer follows, on boards they follow or on `boardUuid`, plus their own.
 */
export async function findFollowedLiveSessions(
  viewerId: string,
  options: { boardUuid?: string | null; limit: number },
): Promise<LiveSession[]> {
  const now = new Date();
  const [followedBoards, selectedBoard] = await Promise.all([
    loadFollowedBoards(viewerId),
    options.boardUuid ? loadSelectedBoard(options.boardUuid, viewerId) : Promise.resolve(null),
  ]);

  const armBoards = new Map<number, ArmBoard>();
  for (const board of [...followedBoards, ...(selectedBoard ? [selectedBoard] : [])]) {
    armBoards.set(board.id, board);
  }
  const redisBoundSessionIds = await readBoardBoundSessionIds([...armBoards.keys()]);

  const followedUserIds = () =>
    db
      .select({ userId: dbSchema.userFollows.followingId })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followerId, viewerId));
  const participants = dbSchema.boardSessionParticipants;
  const socialArm = or(
    eq(boardSessions.createdByUserId, viewerId),
    inArray(boardSessions.createdByUserId, followedUserIds()),
    participantRowExists(
      or(
        eq(participants.userId, viewerId),
        // Participant rows are permanent, so an unbounded match would let
        // followed climbers' long-gone visits fill the 50-row cap. Only a row
        // written inside the candidate window can still be a live roster seat.
        and(inArray(participants.userId, followedUserIds()), gt(participants.joinedAt, windowStart(now))),
      ) as SQL,
    ),
  );

  const candidates = await loadCandidates(
    and(
      candidateBase(now),
      visibilityPrefilter(viewerId),
      or(socialArm, boardArmPrefilter([...armBoards.values()], redisBoundSessionIds)),
    ) as SQL,
  );

  const followedBoardIds = new Set(followedBoards.map((board) => board.id));
  return buildLiveSessions({
    viewerId,
    candidates,
    now,
    limit: options.limit,
    mode: 'home',
    heldBoardIds: new Set(armBoards.keys()),
    boardReasons: (boardId) => {
      const reasons: LiveSessionReason[] = [];
      if (boardId !== undefined && followedBoardIds.has(boardId)) reasons.push('FOLLOWED_BOARD');
      if (boardId !== undefined && selectedBoard && boardId === selectedBoard.id) reasons.push('SELECTED_BOARD');
      return reasons;
    },
  });
}

/**
 * A board's presence sheet: the live sessions on this board. The caller has
 * already applied the board's read gate (see `boardLiveSessions`); anonymous
 * viewers (`viewerId` null) only see public sessions.
 */
export async function findBoardLiveSessions(boardId: number, viewerId: string | null): Promise<LiveSession[]> {
  const now = new Date();
  const [boardRow] = await db
    .select({ id: dbSchema.userBoards.id, slug: dbSchema.userBoards.slug })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (!boardRow) return [];
  const board: ArmBoard = { id: Number(boardRow.id), slug: boardRow.slug };

  const redisBoundSessionIds = await readBoardBoundSessionIds([board.id]);
  const candidates = await loadCandidates(
    and(candidateBase(now), visibilityPrefilter(viewerId), boardArmPrefilter([board], redisBoundSessionIds)) as SQL,
  );

  return buildLiveSessions({
    viewerId,
    candidates,
    now,
    limit: BOARD_LIVE_SESSIONS_LIMIT,
    mode: 'board',
    // The caller passed this board's read gate to get here, so it is held.
    heldBoardIds: new Set([board.id]),
    boardReasons: (resolvedBoardId) => (resolvedBoardId === board.id ? ['SELECTED_BOARD'] : []),
  });
}
