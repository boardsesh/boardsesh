import { canViewResourceLocation, resourceAccess, resourceAccessCondition } from './privacy';
import { and, desc, eq, exists, gt, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
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
import { canReadClimbContent, sessionsVisibleUserIds } from './board-session-privacy';
import { toBoardQueuePreviewItem } from './board-queue-preview';
import { isSprayBoardType, sprayBoardRowIsReadable } from '../graphql/resolvers/climbs/spray-read-access';
import {
  consensusGradeJoinCondition,
  consensusGradeTable,
  difficultyNameWithFallbackExpr,
} from '../graphql/resolvers/shared/sql-expressions';
import { logger } from '../utils/logger';
import { parseSessionBoardPath, resolveSessionBoards, toBoardId } from './session-board';

export {
  parseSessionBoardPath,
  resolveSessionBoards as resolveLiveSessionBoards,
  type ParsedBoardConfig,
  type ParsedSessionBoardPath,
} from './session-board';

/**
 * Live sessions: who is climbing right now, for Home's "Climbing now" rail
 * (`followedLiveSessions`) and a board's presence sheet (`boardLiveSessions`).
 *
 * The pipeline, in order — each stage only sees what the previous one kept:
 *
 * 1. **Candidates**: SQL narrows explicit, active, not-ended sessions touched
 *    in the last 4h. Light metadata batches resolve board-arm matches before
 *    counting the newest 50 candidates; exact SQL social matches still count.
 *    Private sessions the viewer cannot list never leave Postgres.
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
  identityVisible: boolean;
  deletedAt: Date | null;
  gymName: string | null;
  gymIsPublic: boolean | null;
};

/** A board that can put sessions in the board arm, with what every resolution step matches on. */
type ArmBoard = {
  id: number;
  uuid: string;
  slug: string;
  ownerId: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
};

async function loadBoardRows(
  boardIds: readonly number[],
  viewerId: string | null,
  heldBoardIds: ReadonlySet<number>,
): Promise<Map<number, BoardRow>> {
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
      identityVisible: sql<boolean>`${resourceAccessCondition('board', dbSchema.userBoards.uuid, viewerId, {
        allowUnlistedLink: false,
        unlistedWhen: heldBoardIds.size > 0 ? inArray(dbSchema.userBoards.id, [...heldBoardIds]) : sql`false`,
      })}`,
      deletedAt: dbSchema.userBoards.deletedAt,
      gymName: dbSchema.gyms.name,
      gymIsPublic: dbSchema.gyms.isPublic,
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
 * - it must be live (not deleted) and readable under the board's policy, read
 *   the way `resourceAccess` reads it (the `resource_privacy` row first, the
 *   legacy booleans second), so an Unlisted board saved with the current
 *   controls (`is_public = false`) is judged by its audience, not its flag;
 * - a board the viewer holds the link of (`heldBoardIds`: they follow it,
 *   selected it by uuid, or presented its uuid with the board's own sheet) gets
 *   the link reading. Any other board, including one named only by a session
 *   or by the numeric id the sheet was asked for, gets the no-link reading: an
 *   Unlisted board is named only to people who already hold it;
 * - a spray wall additionally needs its current wall rule; a held UUID permits
 *   Unlisted access, while an admin hide still withdraws it from non-owners.
 */
async function toVisibleBoard(
  row: BoardRow | undefined,
  viewerId: string | null,
  linkHeld: boolean,
): Promise<LiveSessionBoard | null> {
  if (!row || row.deletedAt || !row.identityVisible) return null;
  const isOwner = viewerId !== null && row.ownerId === viewerId;
  if (!isOwner) {
    if (
      isSprayBoardType(row.boardType) &&
      !(await sprayBoardRowIsReadable(row, viewerId, linkHeld ? 'capability' : 'enumerable', db))
    ) {
      return null;
    }
  }
  return {
    uuid: row.uuid,
    name: row.name,
    slug: row.slug,
    boardType: row.boardType,
    // The gym is the board's place: its location policy decides, except that a
    // public gym's name is shown to everyone (projectBoardLocation).
    gymName:
      row.gymIsPublic === true || isOwner || (await canViewResourceLocation(row.uuid, viewerId)) ? row.gymName : null,
  };
}

/**
 * Whether a board may drive the board arm for this viewer. A spray wall that
 * went private, lost the viewer's gym membership or was hidden by an admin
 * stops listing its sessions even though the follow row survives. Uses the
 * enumerable rule for discovery arms; a remembered numeric association is
 * not a presented Unlisted link. Sheet projections separately retain a held UUID.
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

/**
 * `and()` / `or()` over conditions where at least one is always present.
 * Drizzle types both as possibly `undefined` (they drop undefined arguments and
 * return undefined when nothing is left); with a required first condition that
 * cannot happen, and the `??` keeps the type honest without a cast.
 */
function allOf(required: SQL, ...optional: Array<SQL | undefined>): SQL {
  return and(required, ...optional) ?? required;
}

function anyOf(required: SQL, ...optional: Array<SQL | undefined>): SQL {
  return or(required, ...optional) ?? required;
}

function candidateBase(now: Date): SQL {
  return allOf(
    eq(boardSessions.origin, 'explicit'),
    eq(boardSessions.status, 'active'),
    isNull(boardSessions.endedAt),
    gt(boardSessions.lastActivity, windowStart(now)),
  );
}

function windowStart(now: Date): Date {
  return new Date(now.getTime() - LIVE_SESSION_CANDIDATE_WINDOW_MS);
}

/**
 * A `board_session_participants` row for the candidate session, written inside
 * the candidate window. Participant rows are permanent — nothing removes one
 * when its climber leaves — so an unbounded match would let long-gone visits
 * fill the 50-row cap. Only a row written inside the window can still be a
 * live roster seat worth a candidate slot; the live roster confirms it later.
 */
function recentParticipantRowExists(userCondition: SQL, now: Date): SQL {
  const participants = dbSchema.boardSessionParticipants;
  return exists(
    db
      .select({ one: sql`1` })
      .from(participants)
      .where(
        allOf(eq(participants.sessionId, boardSessions.id), gt(participants.joinedAt, windowStart(now)), userCondition),
      ),
  );
}

/**
 * The SQL half of the visibility rule. Listings are discovery, not a link: an
 * unlisted session (a legacy private one) only passes for the viewer who
 * created it or joined it inside the candidate window, and the live roster
 * confirms the latter afterwards.
 */
function visibilityPrefilter(viewerId: string | null, now: Date): SQL {
  return resourceAccessCondition('session', boardSessions.id, viewerId, {
    allowUnlistedLink: false,
    unlistedWhen: viewerId
      ? recentParticipantRowExists(eq(dbSchema.boardSessionParticipants.userId, viewerId), now)
      : undefined,
  });
}

/**
 * Coarse SQL matches for every way a session can point at one of `boards`.
 * Stronger current-board evidence can override a historical tick; metadata
 * paging resolves that precedence before a match counts toward the cap.
 */
function boardArmPrefilter(boards: readonly ArmBoard[], redisBoundSessionIds: readonly string[]): SQL | undefined {
  if (boards.length === 0) return undefined;
  const boardIds = boards.map((board) => board.id);
  const slugs = [...new Set(boards.map((board) => board.slug))];
  // A spray layout identifies one wall; catalogue configurations do not.
  const sprayLayouts = [
    ...new Set(boards.filter((board) => board.boardType === 'spray').map((board) => String(board.layoutId))),
  ];
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
    sprayLayouts.length > 0
      ? and(like(trimmedPath, 'spray/%'), inArray(sql`split_part(${trimmedPath}, '/', 2)`, sprayLayouts))
      : undefined,
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

async function loadCandidates(where: SQL, boardIds: ReadonlySet<number>, socialArm?: SQL): Promise<CandidateSession[]> {
  const candidates: CandidateSession[] = [];
  const seen = new Set<string>();
  let cursor: { lastActivity: string; id: string } | undefined;
  // Only light metadata and board resolution run outside the 50-candidate cap.
  // The fixed four-hour lookback bounds this scan to the active candidate set;
  // strict keyset ordering and deduplication keep updates from repeating rows.
  while (candidates.length < LIVE_SESSION_CANDIDATE_CAP) {
    const rows = await db
      .select({
        ...candidateColumns,
        // Keep PostgreSQL's full timestamp precision for the next page.
        cursorAt: sql<string>`${boardSessions.lastActivity}::text`,
        socialMatch: socialArm ? sql<boolean>`COALESCE((${socialArm}), false)` : sql<boolean>`false`,
      })
      .from(boardSessions)
      .where(
        allOf(
          where,
          cursor
            ? sql`(${boardSessions.lastActivity}, ${boardSessions.id}) < (${cursor.lastActivity}::timestamp, ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(desc(boardSessions.lastActivity), desc(boardSessions.id))
      .limit(LIVE_SESSION_CANDIDATE_CAP);
    if (rows.length === 0) break;
    const batch = rows.map(({ cursorAt: _cursorAt, socialMatch: _socialMatch, ...row }) => ({
      ...row,
      boardId: toBoardId(row.boardId),
    }));
    const resolvedBoards = boardIds.size > 0 ? await resolveSessionBoards(batch) : new Map<string, number>();
    for (const [index, candidate] of batch.entries()) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const boardId = resolvedBoards.get(candidate.id);
      if (rows[index].socialMatch || (boardId !== undefined && boardIds.has(boardId))) candidates.push(candidate);
      if (candidates.length === LIVE_SESSION_CANDIDATE_CAP) break;
    }
    const lastCandidateRow = rows[rows.length - 1];
    cursor = { lastActivity: lastCandidateRow.cursorAt, id: lastCandidateRow.id };
    if (rows.length < LIVE_SESSION_CANDIDATE_CAP) break;
  }
  return candidates;
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
      // The hardest send's own board, so the fallback label below is on that
      // board's scale (MoonBoard's 16 is "6a/V2", not the shared "6a/V3").
      hardestBoardType: sql<
        string | null
      >`(ARRAY_AGG(${ticks.boardType} ORDER BY ${hardestOrder}) FILTER (WHERE ${isSend}))[1]`,
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
        row.hardestGradeName ||
        (hardestDifficulty != null ? getGradeLabel(hardestDifficulty, row.hardestBoardType) : null) ||
        null,
    });
  }
  return stats;
}

/**
 * The climb on the wall, authorized for this viewer before selecting display
 * fields. Session access alone never authorizes a restricted authored climb.
 */
async function loadCurrentClimb(sessionId: string, viewerId: string | null): Promise<LiveSessionClimb | null> {
  try {
    const queueState = await roomManager.getQueueState(sessionId);
    if (!queueState.currentClimbQueueItem) return null;
    if (!(await canReadClimbContent(queueState.currentClimbQueueItem.climb.uuid, viewerId))) return null;
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

  const boardBySession = await resolveSessionBoards(live);
  // Board mode never lists a session on another board, so it never pays for
  // that session's roster.
  const shortlist =
    mode === 'board'
      ? live.filter((candidate) => boardReasons(boardBySession.get(candidate.id)).includes('SELECTED_BOARD'))
      : live;
  if (shortlist.length === 0) return [];

  // `withoutLink` is discovery access; `withLink` is what the invite link
  // opens. A session the viewer may only reach by link is listed only once the
  // live roster shows them in it. One policy load per candidate.
  const sessionAccess = await Promise.all(
    shortlist.map((candidate) => resourceAccess('session', candidate.id, viewerId)),
  );
  const rosters = await Promise.all(
    shortlist.map((candidate, index) =>
      sessionAccess[index].withLink ? loadRoster(candidate.id) : Promise.resolve([]),
    ),
  );
  const withRosters = shortlist.flatMap((candidate, index) => {
    const roster = rosters[index];
    const viewerIsMember =
      viewerId !== null &&
      (candidate.createdByUserId === viewerId || roster.some((member) => member.userId === viewerId));
    // Visibility: an unlisted or restricted session is pruned for everyone not in it.
    if (!sessionAccess[index].withoutLink && !(sessionAccess[index].withLink && viewerIsMember)) return [];
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

  // The preference beats the follow: a followed climber who stays anonymous on
  // a session's board neither lists it as a following session, lifts it up the
  // rail, nor shows among its followed climbers. Judged on the board the card
  // shows, the one the session itself is on. One query, and none unless the
  // viewer follows somebody on these rosters.
  const namedFollowed = await sessionsVisibleUserIds(
    withRosters.map(({ candidate, roster }) => ({
      session: candidate,
      userIds: [...signedInUserIds(roster), candidate.createdByUserId].filter(
        (userId) => !!userId && followed.has(userId),
      ),
    })),
    viewerId,
    boardBySession,
  );

  const listed: ListedSession[] = [];
  for (const [index, entry] of withRosters.entries()) {
    const { candidate, roster, viewerIsMember } = entry;
    // Only a followed climber who is actually on the live roster counts — a
    // participant row is permanent and outlives leaving.
    const followedParticipantIds = signedInUserIds(roster).filter((userId) => namedFollowed[index].has(userId));
    const followsCreator = candidate.createdByUserId !== null && namedFollowed[index].has(candidate.createdByUserId);
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

  const pageUserIds = page.flatMap(({ candidate, roster }) => [
    ...signedInUserIds(roster),
    ...(candidate.createdByUserId ? [candidate.createdByUserId] : []),
  ]);
  // Every climber on the page is named by their own account, unless they stay
  // anonymous on boards they don't own and the card's board is not theirs.
  // Following them does not override that. One lookup for the page.
  const [profiles, tickStats, boardRows, visibleByCard] = await Promise.all([
    loadProfiles(pageUserIds),
    loadTickStats(page.map(({ candidate }) => candidate.id)),
    loadBoardRows(
      page.flatMap(({ boardId }) => (boardId ? [boardId] : [])),
      viewerId,
      heldBoardIds,
    ),
    sessionsVisibleUserIds(
      page.map(({ candidate, roster }) => ({
        session: candidate,
        userIds: [...signedInUserIds(roster), candidate.createdByUserId],
      })),
      viewerId,
      boardBySession,
    ),
  ]);

  return Promise.all(
    page.map(async (entry, pageIndex): Promise<LiveSession> => {
      const { candidate, roster, followedParticipantIds } = entry;
      const visibleUserIds = visibleByCard[pageIndex];
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
      const visibleMembers = new Set(
        members.map((member) => member.userId).filter((userId) => visibleUserIds.has(userId)),
      );
      const participants = [
        ...members.filter((member) => followedSet.has(member.userId)),
        ...members.filter((member) => !followedSet.has(member.userId)),
      ]
        .filter((member) => visibleMembers.has(member.userId))
        .slice(0, LIVE_SESSION_ROSTER_CAP)
        .map((member) => toUser(member.userId, member));

      const creatorId =
        candidate.createdByUserId && visibleUserIds.has(candidate.createdByUserId) ? candidate.createdByUserId : null;
      const [board, currentClimb] = await Promise.all([
        toVisibleBoard(boardRow, viewerId, entry.boardId !== undefined && heldBoardIds.has(entry.boardId)),
        // Public sessions only, and only when the board type is known and is
        // not a spray wall: a spray wall's climbs stay private to the wall even
        // when the session is public, and an unknown type could be one.
        candidate.isPublic && boardType !== null && !isSprayBoardType(boardType)
          ? loadCurrentClimb(candidate.id, viewerId)
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
        followedParticipantIds: followedParticipantIds.filter((userId) => visibleMembers.has(userId)),
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

function toArmBoard(row: {
  id: number;
  uuid: string;
  slug: string;
  ownerId: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
}): ArmBoard {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    slug: row.slug,
    ownerId: row.ownerId,
    boardType: row.boardType,
    layoutId: Number(row.layoutId),
    sizeId: Number(row.sizeId),
  };
}

async function loadFollowedBoards(viewerId: string): Promise<ArmBoard[]> {
  const rows = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      slug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      ownerId: dbSchema.userBoards.ownerId,
    })
    .from(dbSchema.boardFollows)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.boardFollows.boardUuid))
    .where(and(eq(dbSchema.boardFollows.userId, viewerId), isNull(dbSchema.userBoards.deletedAt)));
  const usable = await Promise.all(rows.map((row) => viewerMayUseBoardArm(row, viewerId)));
  return rows.filter((_, index) => usable[index]).map(toArmBoard);
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
      uuid: dbSchema.userBoards.uuid,
      slug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      ownerId: dbSchema.userBoards.ownerId,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (!row || !(await viewerMayUseBoardArm(row, viewerId))) return null;
  return toArmBoard(row);
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
  const socialArm = anyOf(
    eq(boardSessions.createdByUserId, viewerId),
    inArray(boardSessions.createdByUserId, followedUserIds()),
    recentParticipantRowExists(
      anyOf(eq(participants.userId, viewerId), inArray(participants.userId, followedUserIds())),
      now,
    ),
  );

  const candidates = await loadCandidates(
    allOf(
      candidateBase(now),
      visibilityPrefilter(viewerId, now),
      anyOf(socialArm, boardArmPrefilter([...armBoards.values()], redisBoundSessionIds)),
    ),
    new Set(armBoards.keys()),
    socialArm,
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
 * viewers (`viewerId` null) only see public sessions. `linkHeld` says the
 * caller presented the board's uuid, not just its countable numeric id: only
 * then may an Unlisted board's own name, slug and uuid ride on the sessions.
 */
export async function findBoardLiveSessions(
  boardId: number,
  viewerId: string | null,
  options: { linkHeld: boolean },
): Promise<LiveSession[]> {
  const now = new Date();
  const [boardRow] = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      slug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      ownerId: dbSchema.userBoards.ownerId,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (!boardRow) return [];
  const board = toArmBoard(boardRow);

  const redisBoundSessionIds = await readBoardBoundSessionIds([board.id]);
  const candidates = await loadCandidates(
    allOf(candidateBase(now), visibilityPrefilter(viewerId, now), boardArmPrefilter([board], redisBoundSessionIds)),
    new Set([board.id]),
  );

  return buildLiveSessions({
    viewerId,
    candidates,
    now,
    limit: BOARD_LIVE_SESSIONS_LIMIT,
    mode: 'board',
    // Held only when the caller presented the board's link. The numeric id
    // passed the no-link gate, which says nothing about holding an Unlisted board.
    heldBoardIds: options.linkHeld ? new Set([board.id]) : new Set<number>(),
    boardReasons: (resolvedBoardId) => (resolvedBoardId === board.id ? ['SELECTED_BOARD'] : []),
  });
}
