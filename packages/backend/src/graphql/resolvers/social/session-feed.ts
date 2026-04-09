import { eq, and, desc, sql, count as drizzleCount, isNull, inArray } from 'drizzle-orm';

import { createRequestDb } from '../../../db/client';

const db = createRequestDb();

import type { RequestDbInstance } from '../../../db/client';import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import { validateInput } from '../shared/helpers';
import { ActivityFeedInputSchema } from '../../../validation/schemas';
import { encodeOffsetCursor, decodeOffsetCursor } from '../../../utils/feed-cursor';
import type { SessionFeedItem, SessionDetail, SessionGradeDistributionItem, SessionFeedParticipant, SessionDetailTick } from '@boardsesh/shared-schema';
import { buildGradeDistributionFromTicks, computeSessionAggregates } from './session-feed-utils';

export const sessionFeedQueries = {
  /**
   * Session-grouped activity feed (public, no auth required).
   * Groups ticks into sessions based on party mode sessionId or inferred sessions.
   * Every tick now has either session_id or inferred_session_id set.
   * Always chronological (newest first). Uses offset pagination.
   */
  sessionGroupedFeed: async (
    _: unknown,
    { input }: { input?: Record<string, unknown> },
  ) => {
    const validatedInput = validateInput(ActivityFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;

    const offset = validatedInput.cursor
      ? (decodeOffsetCursor(validatedInput.cursor) ?? 0)
      : 0;

    // Board filter
    let boardTypeFilter: string | null = null;
    let layoutIdFilter: number | null = null;
    if (validatedInput.boardUuid) {
      const board = await db
        .select({ boardType: dbSchema.userBoards.boardType, layoutId: dbSchema.userBoards.layoutId })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid))
        .limit(1)
        .then(rows => rows[0]);

      if (board) {
        boardTypeFilter = board.boardType;
        layoutIdFilter = board.layoutId;
      }
    }

    // Optimized query: read pre-computed stats from inferred_sessions table
    // instead of aggregating all ticks on every request. Party sessions (small
    // subset) still aggregate from ticks using the session_id index.
    let sessionRows;
    try {
      // Build board filter conditions for inferred sessions (EXISTS subquery)
      const inferredBoardFilter = boardTypeFilter
        ? sql`AND EXISTS (
            SELECT 1 FROM boardsesh_ticks tf
            ${layoutIdFilter !== null ? sql`LEFT JOIN board_climbs cf ON cf.uuid = tf.climb_uuid AND cf.board_type = tf.board_type` : sql``}
            WHERE tf.inferred_session_id = s.id
              AND tf.board_type = ${boardTypeFilter}
              ${layoutIdFilter !== null ? sql`AND cf.layout_id = ${layoutIdFilter}` : sql``}
          )`
        : sql``;

      // Build board filter conditions for party session ticks
      const partyBoardFilter = boardTypeFilter
        ? sql`AND t.board_type = ${boardTypeFilter}`
        : sql``;
      const partyLayoutFilter = layoutIdFilter !== null
        ? sql`AND cf.layout_id = ${layoutIdFilter}`
        : sql``;
      const partyLayoutJoin = layoutIdFilter !== null
        ? sql`LEFT JOIN board_climbs cf ON cf.uuid = t.climb_uuid AND cf.board_type = t.board_type`
        : sql``;

      sessionRows = await db.execute(sql`
        WITH session_base AS (
          -- Inferred sessions: read directly from materialized table (uses last_tick_idx)
          SELECT
            s.id AS session_id,
            'inferred'::text AS session_type,
            s.first_tick_at AS session_first_tick,
            s.last_tick_at AS session_last_tick,
            s.tick_count::int AS tick_count,
            s.total_sends::int AS total_sends,
            s.total_flashes::int AS total_flashes,
            s.total_attempts::int AS total_attempts
          FROM inferred_sessions s
          WHERE s.tick_count > 0
            ${inferredBoardFilter}

          UNION ALL

          -- Party sessions: aggregate from ticks (indexed by session_id, much smaller set)
          SELECT
            t.session_id,
            'party'::text,
            MIN(t.climbed_at),
            MAX(t.climbed_at),
            COUNT(*)::int,
            COUNT(*) FILTER (WHERE t.status IN ('flash', 'send'))::int,
            COUNT(*) FILTER (WHERE t.status = 'flash')::int,
            (
              COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
              + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
            )::int
          FROM boardsesh_ticks t
          ${partyLayoutJoin}
          WHERE t.session_id IS NOT NULL
            ${partyBoardFilter}
            ${partyLayoutFilter}
          GROUP BY t.session_id
        ),
        scored AS (
          SELECT
            sb.*,
            COALESCE(vc.score, 0) AS vote_score,
            COALESCE(vc.upvotes, 0) AS vote_up,
            COALESCE(vc.downvotes, 0) AS vote_down,
            COALESCE(cc.comment_count, 0) AS comment_count
          FROM session_base sb
          LEFT JOIN vote_counts vc
            ON vc.entity_type = 'session' AND vc.entity_id = sb.session_id
          LEFT JOIN (
            SELECT entity_id, COUNT(*) AS comment_count
            FROM comments
            WHERE entity_type = 'session' AND deleted_at IS NULL
            GROUP BY entity_id
          ) cc ON cc.entity_id = sb.session_id
        )
        SELECT *
        FROM scored
        ORDER BY session_last_tick DESC
        OFFSET ${offset}
        LIMIT ${limit + 1}
      `);
    } catch (err) {
      console.error('[sessionGroupedFeed] SQL error:', err);
      throw err;
    }

    // db.execute() returns QueryResult (neon-serverless) with .rows property
    const rows = (sessionRows as unknown as { rows: Array<{
      session_id: string;
      session_type: string;
      session_first_tick: string;
      session_last_tick: string;
      tick_count: number;
      total_sends: number;
      total_flashes: number;
      total_attempts: number;
      vote_score: number;
      vote_up: number;
      vote_down: number;
      comment_count: number;
    }> }).rows;

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    // Batch enrichment: 4 queries total instead of scanning all ticks
    const sessionIds = resultRows.map((r) => r.session_id);
    const sessionTypes = new Map(resultRows.map((r) => [r.session_id, r.session_type]));

    const [participantMap, gradeDistMap, metaMap, boardTypesMap] = await Promise.all([
      fetchParticipantsBatch(sessionIds),
      fetchGradeDistributionBatch(sessionIds),
      fetchSessionMetaBatch(sessionIds, sessionTypes),
      fetchBoardTypesBatch(sessionIds),
    ]);

    const sessions: SessionFeedItem[] = resultRows.map((row) => {
      const participants = participantMap.get(row.session_id) ?? [];
      const gradeDistribution = gradeDistMap.get(row.session_id) ?? [];
      const sessionMeta = metaMap.get(row.session_id) ?? null;
      const boardTypes = boardTypesMap.get(row.session_id) ?? [];

      const firstTime = new Date(row.session_first_tick).getTime();
      const lastTime = new Date(row.session_last_tick).getTime();
      const durationMinutes = Math.round((lastTime - firstTime) / 60000) || null;

      return {
        sessionId: row.session_id,
        sessionType: row.session_type as 'party' | 'inferred',
        sessionName: sessionMeta?.name || null,
        ownerUserId: sessionMeta?.ownerUserId || null,
        participants,
        totalSends: Number(row.total_sends),
        totalFlashes: Number(row.total_flashes),
        totalAttempts: Number(row.total_attempts),
        tickCount: Number(row.tick_count),
        gradeDistribution,
        boardTypes,
        hardestGrade: gradeDistribution.length > 0 ? gradeDistribution[0].grade : null,
        firstTickAt: typeof row.session_first_tick === 'object'
          ? (row.session_first_tick as unknown as Date).toISOString()
          : String(row.session_first_tick),
        lastTickAt: typeof row.session_last_tick === 'object'
          ? (row.session_last_tick as unknown as Date).toISOString()
          : String(row.session_last_tick),
        durationMinutes,
        goal: sessionMeta?.goal || null,
        upvotes: Number(row.vote_up),
        downvotes: Number(row.vote_down),
        voteScore: Number(row.vote_score),
        commentCount: Number(row.comment_count),
      };
    });

    const nextCursor = hasMore ? encodeOffsetCursor(offset + limit) : null;

    return { sessions, cursor: nextCursor, hasMore };
  },

  /**
   * Get full detail for a single session.
   */
  sessionDetail: async (
    _: unknown,
    { sessionId }: { sessionId: string },
  ): Promise<SessionDetail | null> => {
    if (!sessionId) return null;

    // Check if it's a party mode session
    const [partySession] = await db
      .select()
      .from(dbSchema.boardSessions)
      .where(eq(dbSchema.boardSessions.id, sessionId))
      .limit(1);

    const isParty = !!partySession;

    // Check if it's an inferred session
    let inferredSession: typeof dbSchema.inferredSessions.$inferSelect | undefined;
    if (!isParty) {
      const [result] = await db
        .select()
        .from(dbSchema.inferredSessions)
        .where(eq(dbSchema.inferredSessions.id, sessionId))
        .limit(1);

      if (!result) return null;
      inferredSession = result;
    }

    // Fetch ticks for this session
    const tickCondition = isParty
      ? eq(dbSchema.boardseshTicks.sessionId, sessionId)
      : eq(dbSchema.boardseshTicks.inferredSessionId, sessionId);

    const tickRows = await db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .where(tickCondition)
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    if (tickRows.length === 0) return null;

    // Batch-fetch tick vote counts
    const tickUuids = tickRows.map((r) => r.tick.uuid);
    const tickVoteCounts = tickUuids.length > 0
      ? await db
          .select({
            entityId: dbSchema.voteCounts.entityId,
            upvotes: sql<number>`COALESCE(${dbSchema.voteCounts.upvotes}, 0)`,
          })
          .from(dbSchema.voteCounts)
          .where(
            and(
              eq(dbSchema.voteCounts.entityType, 'tick'),
              inArray(dbSchema.voteCounts.entityId, tickUuids),
            ),
          )
      : [];
    const tickVoteMap = new Map(tickVoteCounts.map((v) => [v.entityId, Number(v.upvotes)]));

    // Build ticks (totalAttempts added below)
    const ticks: SessionDetailTick[] = tickRows.map((row) => ({
      uuid: row.tick.uuid,
      userId: row.tick.userId,
      climbUuid: row.tick.climbUuid,
      climbName: row.climbName || null,
      boardType: row.tick.boardType,
      layoutId: row.layoutId,
      angle: row.tick.angle,
      status: row.tick.status,
      attemptCount: row.tick.attemptCount,
      difficulty: row.tick.difficulty,
      difficultyName: row.difficultyName || null,
      quality: row.tick.quality,
      isMirror: row.tick.isMirror ?? false,
      isBenchmark: row.tick.isBenchmark ?? false,
      comment: row.tick.comment || null,
      frames: row.frames || null,
      setterUsername: row.setterUsername || null,
      climbedAt: row.tick.climbedAt,
      upvotes: tickVoteMap.get(row.tick.uuid) ?? 0,
      totalAttempts: null,
    }));

    // Compute totalAttempts for each tick: sum of attemptCount since last
    // successful ascent (flash/send) by the same user on the same climb.
    // Build unique combos of (userId, climbUuid, boardType, angle) from ticks
    const comboSet = new Set<string>();
    const comboValues: Array<{ userId: string; climbUuid: string; boardType: string; angle: number }> = [];
    for (const row of tickRows) {
      const key = `${row.tick.userId}|${row.tick.climbUuid}|${row.tick.boardType}|${row.tick.angle}`;
      if (!comboSet.has(key)) {
        comboSet.add(key);
        comboValues.push({
          userId: row.tick.userId,
          climbUuid: row.tick.climbUuid,
          boardType: row.tick.boardType,
          angle: row.tick.angle,
        });
      }
    }

    if (comboValues.length > 0) {
      // Build VALUES clause for the combos
      const valuesSql = sql.join(
        comboValues.map(
          (c) => sql`(${c.userId}, ${c.climbUuid}, ${c.boardType}, ${c.angle})`,
        ),
        sql`, `,
      );

      const totalAttemptsResult = await db.execute(sql`
        WITH combos(user_id, climb_uuid, board_type, angle) AS (
          VALUES ${valuesSql}
        ),
        last_success AS (
          SELECT
            t.user_id,
            t.climb_uuid,
            t.board_type,
            t.angle,
            MAX(t.climbed_at) AS last_success_at
          FROM boardsesh_ticks t
          INNER JOIN combos c
            ON t.user_id = c.user_id
            AND t.climb_uuid = c.climb_uuid
            AND t.board_type = c.board_type
            AND t.angle = c.angle::int
          WHERE t.status IN ('flash', 'send')
          GROUP BY t.user_id, t.climb_uuid, t.board_type, t.angle
        ),
        attempts_since AS (
          SELECT
            t.user_id,
            t.climb_uuid,
            t.board_type,
            t.angle,
            SUM(t.attempt_count)::int AS total
          FROM boardsesh_ticks t
          INNER JOIN combos c
            ON t.user_id = c.user_id
            AND t.climb_uuid = c.climb_uuid
            AND t.board_type = c.board_type
            AND t.angle = c.angle::int
          LEFT JOIN last_success ls
            ON t.user_id = ls.user_id
            AND t.climb_uuid = ls.climb_uuid
            AND t.board_type = ls.board_type
            AND t.angle = ls.angle
          WHERE t.climbed_at >= COALESCE(ls.last_success_at, '1970-01-01'::timestamp)
          GROUP BY t.user_id, t.climb_uuid, t.board_type, t.angle
        )
        SELECT * FROM attempts_since
      `);

      const attemptsRows = (totalAttemptsResult as unknown as {
        rows: Array<{
          user_id: string;
          climb_uuid: string;
          board_type: string;
          angle: number;
          total: number;
        }>;
      }).rows;

      // Build lookup map
      const attemptsMap = new Map<string, number>();
      for (const r of attemptsRows) {
        attemptsMap.set(`${r.user_id}|${r.climb_uuid}|${r.board_type}|${r.angle}`, r.total);
      }

      // Attach totalAttempts to each tick
      for (const tick of ticks) {
        const key = `${tick.userId}|${tick.climbUuid}|${tick.boardType}|${tick.angle}`;
        tick.totalAttempts = attemptsMap.get(key) ?? null;
      }
    }

    // Compute aggregates
    const userIds = [...new Set(tickRows.map((r) => r.tick.userId))];
    const boardTypes = [...new Set(tickRows.map((r) => r.tick.boardType))];

    const { totalSends, totalFlashes, totalAttempts } = computeSessionAggregates(tickRows);

    const participants = await fetchParticipants(sessionId, isParty ? 'party' : 'inferred', userIds);
    const gradeDistribution = buildGradeDistributionFromTicks(tickRows);

    // Timestamps
    const sortedTicks = [...tickRows].sort(
      (a, b) => new Date(a.tick.climbedAt).getTime() - new Date(b.tick.climbedAt).getTime(),
    );
    const firstTickAt = sortedTicks[0].tick.climbedAt;
    const lastTickAt = sortedTicks[sortedTicks.length - 1].tick.climbedAt;
    const durationMinutes = Math.round(
      (new Date(lastTickAt).getTime() - new Date(firstTickAt).getTime()) / 60000,
    ) || null;

    // Hardest grade
    const gradesSorted = tickRows
      .filter((r) => r.difficultyName && (r.tick.status === 'flash' || r.tick.status === 'send'))
      .sort((a, b) => (b.tick.difficulty ?? 0) - (a.tick.difficulty ?? 0));
    const hardestGrade = gradesSorted.length > 0 ? gradesSorted[0].difficultyName : null;

    // Vote/comment counts
    const [voteData] = await db
      .select({
        upvotes: sql<number>`COALESCE(upvotes, 0)`,
        downvotes: sql<number>`COALESCE(downvotes, 0)`,
        score: sql<number>`COALESCE(score, 0)`,
      })
      .from(dbSchema.voteCounts)
      .where(
        and(
          sql`${dbSchema.voteCounts.entityType} = 'session'`,
          eq(dbSchema.voteCounts.entityId, sessionId),
        ),
      )
      .limit(1);

    const [commentData] = await db
      .select({ count: drizzleCount() })
      .from(dbSchema.comments)
      .where(
        and(
          sql`${dbSchema.comments.entityType} = 'session'`,
          eq(dbSchema.comments.entityId, sessionId),
          isNull(dbSchema.comments.deletedAt),
        ),
      );

    // Session metadata
    const sessionName = isParty
      ? partySession?.name || null
      : inferredSession?.name || null;
    const goal = isParty
      ? partySession?.goal || null
      : inferredSession?.description || null;
    const ownerUserId = isParty
      ? partySession?.createdByUserId || null
      : inferredSession?.userId || null;

    return {
      sessionId,
      sessionType: isParty ? 'party' : 'inferred',
      sessionName,
      ownerUserId,
      participants,
      totalSends,
      totalFlashes,
      totalAttempts,
      tickCount: tickRows.length,
      gradeDistribution,
      boardTypes,
      hardestGrade,
      firstTickAt,
      lastTickAt,
      durationMinutes,
      goal,
      ticks,
      upvotes: voteData ? Number(voteData.upvotes) : 0,
      downvotes: voteData ? Number(voteData.downvotes) : 0,
      voteScore: voteData ? Number(voteData.score) : 0,
      commentCount: commentData ? Number(commentData.count) : 0,
    };
  },
};

/**
 * Build WHERE clause for tick lookups.
 * - Party mode: filter by session_id
 * - Inferred: filter by inferred_session_id
 */
function tickSessionFilter(sessionId: string, sessionType: string) {
  return sessionType === 'party'
    ? sql`t.session_id = ${sessionId}`
    : sql`t.inferred_session_id = ${sessionId}`;
}

/**
 * Fetch participant info for a session
 */
async function fetchParticipants(
  sessionId: string,
  sessionType: string,
  userIds: string[],
): Promise<SessionFeedParticipant[]> {
  if (userIds.length === 0) return [];

  const whereClause = tickSessionFilter(sessionId, sessionType);

  const participantRows = await db.execute(sql`
    SELECT
      t.user_id AS "userId",
      COALESCE(up.display_name, u.name) AS "displayName",
      COALESCE(up.avatar_url, u.image) AS "avatarUrl",
      COUNT(*) FILTER (WHERE t.status IN ('flash', 'send'))::int AS sends,
      COUNT(*) FILTER (WHERE t.status = 'flash')::int AS flashes,
      (
        COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
        + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
      )::int AS attempts
    FROM boardsesh_ticks t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN user_profiles up ON up.user_id = t.user_id
    WHERE ${whereClause}
    GROUP BY t.user_id, up.display_name, u.name, up.avatar_url, u.image
    ORDER BY sends DESC
  `);

  // db.execute() returns QueryResult with .rows property
  return ((participantRows as unknown as { rows: Array<{
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    sends: number;
    flashes: number;
    attempts: number;
  }> }).rows).map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    sends: r.sends,
    flashes: r.flashes,
    attempts: r.attempts,
  }));
}

// buildGradeDistributionFromTicks and computeSessionAggregates are imported from ./session-feed-utils

// ============================================
// Batched enrichment functions for feed (3 queries instead of 3×N)
// ============================================

/**
 * Fetch participants for multiple sessions in a single query.
 * Returns a Map from sessionId to participants array.
 */
async function fetchParticipantsBatch(
  sessionIds: string[],
): Promise<Map<string, SessionFeedParticipant[]>> {
  if (sessionIds.length === 0) return new Map();

  const result = await db.execute(sql`
    SELECT
      COALESCE(t.session_id, t.inferred_session_id) AS effective_session_id,
      t.user_id AS "userId",
      COALESCE(up.display_name, u.name) AS "displayName",
      COALESCE(up.avatar_url, u.image) AS "avatarUrl",
      COUNT(*) FILTER (WHERE t.status IN ('flash', 'send'))::int AS sends,
      COUNT(*) FILTER (WHERE t.status = 'flash')::int AS flashes,
      (
        COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
        + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
      )::int AS attempts
    FROM boardsesh_ticks t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN user_profiles up ON up.user_id = t.user_id
    WHERE COALESCE(t.session_id, t.inferred_session_id) IN ${sql`(${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})`}
    GROUP BY effective_session_id, t.user_id, up.display_name, u.name, up.avatar_url, u.image
    ORDER BY sends DESC
  `);

  const rows = (result as unknown as { rows: Array<{
    effective_session_id: string;
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    sends: number;
    flashes: number;
    attempts: number;
  }> }).rows;

  const map = new Map<string, SessionFeedParticipant[]>();
  for (const r of rows) {
    const participants = map.get(r.effective_session_id) ?? [];
    participants.push({
      userId: r.userId,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl,
      sends: r.sends,
      flashes: r.flashes,
      attempts: r.attempts,
    });
    map.set(r.effective_session_id, participants);
  }
  return map;
}

/**
 * Fetch grade distributions for multiple sessions in a single query.
 * Returns a Map from sessionId to grade distribution array.
 */
async function fetchGradeDistributionBatch(
  sessionIds: string[],
): Promise<Map<string, SessionGradeDistributionItem[]>> {
  if (sessionIds.length === 0) return new Map();

  const result = await db.execute(sql`
    SELECT
      COALESCE(t.session_id, t.inferred_session_id) AS effective_session_id,
      t.difficulty AS diff_num,
      COUNT(*) FILTER (WHERE t.status = 'flash')::int AS flash,
      COUNT(*) FILTER (WHERE t.status = 'send')::int AS send,
      (
        COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
        + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
      )::int AS attempt
    FROM boardsesh_ticks t
    WHERE COALESCE(t.session_id, t.inferred_session_id) IN ${sql`(${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})`}
      AND t.difficulty IS NOT NULL
    GROUP BY effective_session_id, t.difficulty
    ORDER BY t.difficulty DESC
  `);

  const rows = (result as unknown as { rows: Array<{
    effective_session_id: string;
    diff_num: number;
    flash: number;
    send: number;
    attempt: number;
  }> }).rows;

  const map = new Map<string, SessionGradeDistributionItem[]>();
  for (const r of rows) {
    const grade = getGradeLabel(r.diff_num);
    if (!grade) continue;
    const distribution = map.get(r.effective_session_id) ?? [];
    distribution.push({ grade, flash: r.flash, send: r.send, attempt: r.attempt });
    map.set(r.effective_session_id, distribution);
  }
  return map;
}

/**
 * Fetch session metadata (name, goal, ownerUserId) for multiple sessions in 2 queries.
 * Returns a Map from sessionId to metadata.
 */
async function fetchSessionMetaBatch(
  sessionIds: string[],
  sessionTypes: Map<string, string>,
): Promise<Map<string, { name: string | null; goal: string | null; ownerUserId: string | null }>> {
  if (sessionIds.length === 0) return new Map();

  const partyIds = sessionIds.filter((id) => sessionTypes.get(id) === 'party');
  const inferredIds = sessionIds.filter((id) => sessionTypes.get(id) === 'inferred');

  const map = new Map<string, { name: string | null; goal: string | null; ownerUserId: string | null }>();

  // Batch fetch party sessions
  if (partyIds.length > 0) {
    const partyRows = await db
      .select({
        id: dbSchema.boardSessions.id,
        name: dbSchema.boardSessions.name,
        goal: dbSchema.boardSessions.goal,
        createdByUserId: dbSchema.boardSessions.createdByUserId,
      })
      .from(dbSchema.boardSessions)
      .where(inArray(dbSchema.boardSessions.id, partyIds));

    for (const r of partyRows) {
      map.set(r.id, { name: r.name, goal: r.goal, ownerUserId: r.createdByUserId });
    }
  }

  // Batch fetch inferred sessions
  if (inferredIds.length > 0) {
    const inferredRows = await db
      .select({
        id: dbSchema.inferredSessions.id,
        name: dbSchema.inferredSessions.name,
        description: dbSchema.inferredSessions.description,
        userId: dbSchema.inferredSessions.userId,
      })
      .from(dbSchema.inferredSessions)
      .where(inArray(dbSchema.inferredSessions.id, inferredIds));

    for (const r of inferredRows) {
      map.set(r.id, { name: r.name || null, goal: r.description || null, ownerUserId: r.userId });
    }
  }

  return map;
}

/**
 * Fetch distinct board types for multiple sessions in a single query.
 * Returns a Map from sessionId to board types array.
 */
async function fetchBoardTypesBatch(
  sessionIds: string[],
): Promise<Map<string, string[]>> {
  if (sessionIds.length === 0) return new Map();

  const result = await db.execute(sql`
    SELECT
      COALESCE(t.session_id, t.inferred_session_id) AS effective_session_id,
      ARRAY_AGG(DISTINCT t.board_type) AS board_types
    FROM boardsesh_ticks t
    WHERE COALESCE(t.session_id, t.inferred_session_id) IN ${sql`(${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})`}
    GROUP BY effective_session_id
  `);

  const rows = (result as unknown as { rows: Array<{
    effective_session_id: string;
    board_types: string[];
  }> }).rows;

  const map = new Map<string, string[]>();
  for (const r of rows) {
    map.set(r.effective_session_id, r.board_types);
  }
  return map;
}
