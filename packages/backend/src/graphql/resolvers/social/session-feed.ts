import { eq, and, desc, sql, count as drizzleCount, isNull, inArray, type SQL } from 'drizzle-orm';
import { dbRead } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import { rowsFromResult } from '@boardsesh/db/client';
import { requireAuthenticated, validateInput, isNoMatchClimb } from '../shared/helpers';
import { ActivityFeedInputSchema } from '../../../validation/schemas';
import { encodeOffsetCursor, decodeOffsetCursor } from '../../../utils/feed-cursor';
import type {
  SessionFeedItem,
  SessionFeedBetaHighlight,
  SessionDetail,
  SessionGradeDistributionItem,
  SessionFeedParticipant,
  SessionFeedTickHighlight,
  SessionDetailTick,
  BetaLinksGqlRow,
  ConnectionContext,
} from '@boardsesh/shared-schema';
import { logger } from '../../../utils/logger';
import { buildGradeDistributionFromTicks, computeSessionAggregates } from './session-feed-utils';

type SessionFeedFilterOptions = {
  boardIdFilter: number | null;
  // Single-climber scope ("your sessions" surfaces): aggregates count only this
  // climber's ticks. null on social/following feeds (whole-session). participants[]
  // stays whole-session regardless; it is the leaderboard, not the viewer's stats.
  userIdFilter: string | null;
};

type SessionFeedRow = {
  session_id: string;
  session_type: string;
  session_first_tick: string | Date;
  session_last_tick: string | Date;
  tick_count: number;
  total_sends: number;
  total_flashes: number;
  total_attempts: number;
  vote_score: number;
  vote_up: number;
  vote_down: number;
  comment_count: number;
  daily_user_id: string | null;
  daily_date: string | null;
  daily_display_name: string | null;
  daily_avatar_url: string | null;
  daily_board_types: string[] | null;
  highlight_tick_uuid: string | null;
};

type DailyHighlightKey = {
  sessionId: string;
  userId: string;
  day: string;
};

type DailySessionId = {
  userId: string;
  day: string;
};

type BetaLinkRow = {
  climbUuid: string;
  link: string;
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean | null;
  createdAt: string | null;
  betaLinkTickUuid: string | null;
  boardId: number | null;
};

type FeaturedBetaRow = BetaLinkRow & {
  groupId: string;
  tickUuid: string;
};

function parseDailySessionId(sessionId: string): DailySessionId | null {
  const match = /^daily:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(sessionId);
  if (!match) return null;
  return { userId: match[1], day: match[2] };
}

export const sessionFeedQueries = {
  /**
   * Session-grouped activity feed (public, no auth required).
   * Groups ticks by explicitly-created board sessions, with optional daily
   * fallback highlights for users who did not climb in a session that day.
   * Always chronological (newest first). Uses offset pagination.
   */
  sessionGroupedFeed: async (_: unknown, { input }: { input?: Record<string, unknown> }, ctx?: ConnectionContext) => {
    const validatedInput = validateInput(ActivityFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const userId = validatedInput.userId || null;
    const followingOnly = validatedInput.followingOnly === true;
    const includeDailyHighlights = validatedInput.includeDailyHighlights === true;
    const participantFilterEnabled = !!userId || followingOnly;

    if (followingOnly) {
      if (!ctx) throw new Error('Authentication required to perform this operation');
      requireAuthenticated(ctx);
    }
    const viewerUserId = followingOnly ? (ctx?.userId ?? null) : null;

    const offset = validatedInput.cursor ? (decodeOffsetCursor(validatedInput.cursor) ?? 0) : 0;

    // Board filter — scope to the EXACT board (user_boards.id), not the board
    // type + layout. A layout is shared by 1,000+ gyms, so the old type+layout
    // filter surfaced every gym on that layout. boardsesh_ticks.board_id points
    // at the specific board, and the (board_id, climbed_at) / (board_id, user_id)
    // indexes back the filter.
    let boardIdFilter: number | null = null;
    if (validatedInput.boardUuid) {
      const board = await dbRead
        .select({ id: dbSchema.userBoards.id })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid))
        .limit(1)
        .then((rows) => rows[0]);

      if (board) {
        boardIdFilter = board.id;
      }
    }

    let sessionRows;
    try {
      const sessionBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;
      // Per-user scope: a single userId ("your sessions") counts only that
      // climber's ticks per session. Empty on social/home/following feeds, which
      // keep whole-session aggregates. Mirrors boardIdFilter's null guard.
      const sessionUserFilter = userId !== null ? sql`AND t.user_id = ${userId}` : sql``;
      const shouldIncludeDailyHighlights = includeDailyHighlights && participantFilterEnabled;
      const eligibleUsersCte = userId
        ? sql`eligible_users AS (SELECT ${userId}::text AS user_id),`
        : followingOnly
          ? sql`eligible_users AS (SELECT following_id AS user_id FROM user_follows WHERE follower_id = ${viewerUserId}),`
          : sql``;
      const eligibleSessionsCte = participantFilterEnabled
        ? sql`
        eligible_sessions AS (
          SELECT DISTINCT t.session_id
          FROM boardsesh_ticks t
          INNER JOIN eligible_users eu ON eu.user_id = t.user_id
          WHERE t.session_id IS NOT NULL
            ${sessionBoardFilter}
        ),
        `
        : sql``;
      const dailyHighlightCtes = shouldIncludeDailyHighlights
        ? sql`
        daily_ticks AS (
          SELECT
            t.*,
            t.climbed_at::date AS day,
            COALESCE(t.difficulty, ROUND(bcs.display_difficulty)::int) AS effective_difficulty
          FROM boardsesh_ticks t
          INNER JOIN eligible_users eu ON eu.user_id = t.user_id
          LEFT JOIN board_climb_aliases bca_stats ON bca_stats.board_type = t.board_type AND bca_stats.alias_uuid = t.climb_uuid
          LEFT JOIN board_climb_stats bcs
            ON bcs.climb_uuid = COALESCE(bca_stats.canonical_uuid, t.climb_uuid)
            AND bcs.board_type = t.board_type
            AND bcs.angle = t.angle
          WHERE t.session_id IS NULL
            ${sessionBoardFilter}
            AND NOT EXISTS (
              SELECT 1
              FROM boardsesh_ticks session_tick
              WHERE session_tick.user_id = t.user_id
                AND session_tick.session_id IS NOT NULL
                AND session_tick.climbed_at::date = t.climbed_at::date
            )
        ),
        daily_base AS (
          SELECT
            user_id,
            day,
            MIN(climbed_at) AS session_first_tick,
            MAX(climbed_at) AS session_last_tick,
            COUNT(*)::int AS tick_count,
            COUNT(*) FILTER (WHERE status IN ('flash', 'send'))::int AS total_sends,
            COUNT(*) FILTER (WHERE status = 'flash')::int AS total_flashes,
            (
              COALESCE(SUM(GREATEST(attempt_count - 1, 0)) FILTER (WHERE status = 'send'), 0)
              + COALESCE(SUM(attempt_count) FILTER (WHERE status = 'attempt'), 0)
            )::int AS total_attempts,
            ARRAY_AGG(DISTINCT board_type) AS board_types
          FROM daily_ticks
          GROUP BY user_id, day
        ),
        daily_hardest AS (
          SELECT *
          FROM (
            SELECT
              dt.*,
              ROW_NUMBER() OVER (
                PARTITION BY dt.user_id, dt.day
                ORDER BY COALESCE(dt.effective_difficulty, -1) DESC, dt.climbed_at DESC, dt.id DESC
              ) AS rank
            FROM daily_ticks dt
            WHERE dt.status IN ('flash', 'send')
          ) ranked
          WHERE rank = 1
        ),
        daily_scored AS (
          SELECT
            ('daily:' || db.user_id || ':' || db.day::text) AS session_id,
            'daily_highlight'::text AS session_type,
            db.session_first_tick,
            db.session_last_tick,
            db.tick_count,
            db.total_sends,
            db.total_flashes,
            db.total_attempts,
            COALESCE(vc.score, 0) AS vote_score,
            COALESCE(vc.upvotes, 0) AS vote_up,
            COALESCE(vc.downvotes, 0) AS vote_down,
            COALESCE(cc.comment_count, 0) AS comment_count,
            db.user_id AS daily_user_id,
            db.day::text AS daily_date,
            COALESCE(up.display_name, u.name) AS daily_display_name,
            COALESCE(up.avatar_url, u.image) AS daily_avatar_url,
            db.board_types AS daily_board_types,
            dh.uuid AS highlight_tick_uuid
          FROM daily_base db
          INNER JOIN daily_hardest dh ON dh.user_id = db.user_id AND dh.day = db.day
          LEFT JOIN users u ON u.id = db.user_id
          LEFT JOIN user_profiles up ON up.user_id = db.user_id
          LEFT JOIN vote_counts vc
            ON vc.entity_type = 'tick' AND vc.entity_id = dh.uuid
          LEFT JOIN (
            SELECT entity_id, COUNT(*) AS comment_count
            FROM comments
            WHERE entity_type = 'tick' AND deleted_at IS NULL
            GROUP BY entity_id
          ) cc ON cc.entity_id = dh.uuid
        ),
        `
        : sql``;
      const combinedCte = shouldIncludeDailyHighlights
        ? sql`
        combined AS (
          SELECT
            session_id,
            session_type,
            session_first_tick,
            session_last_tick,
            tick_count,
            total_sends,
            total_flashes,
            total_attempts,
            vote_score,
            vote_up,
            vote_down,
            comment_count,
            NULL::text AS daily_user_id,
            NULL::text AS daily_date,
            NULL::text AS daily_display_name,
            NULL::text AS daily_avatar_url,
            NULL::text[] AS daily_board_types,
            NULL::text AS highlight_tick_uuid
          FROM scored
          UNION ALL
          SELECT
            session_id,
            session_type,
            session_first_tick,
            session_last_tick,
            tick_count,
            total_sends,
            total_flashes,
            total_attempts,
            vote_score,
            vote_up,
            vote_down,
            comment_count,
            daily_user_id,
            daily_date,
            daily_display_name,
            daily_avatar_url,
            daily_board_types,
            highlight_tick_uuid
          FROM daily_scored
        )
        `
        : sql`
        combined AS (
          SELECT
            session_id,
            session_type,
            session_first_tick,
            session_last_tick,
            tick_count,
            total_sends,
            total_flashes,
            total_attempts,
            vote_score,
            vote_up,
            vote_down,
            comment_count,
            NULL::text AS daily_user_id,
            NULL::text AS daily_date,
            NULL::text AS daily_display_name,
            NULL::text AS daily_avatar_url,
            NULL::text[] AS daily_board_types,
            NULL::text AS highlight_tick_uuid
          FROM scored
        )
        `;

      sessionRows = await dbRead.execute(sql`
        WITH
        ${eligibleUsersCte}
        ${eligibleSessionsCte}
        session_base AS (
          SELECT
            t.session_id AS session_id,
            'party'::text AS session_type,
            MIN(t.climbed_at) AS session_first_tick,
            MAX(t.climbed_at) AS session_last_tick,
            COUNT(*)::int AS tick_count,
            COUNT(*) FILTER (WHERE t.status IN ('flash', 'send'))::int AS total_sends,
            COUNT(*) FILTER (WHERE t.status = 'flash')::int AS total_flashes,
            (
              COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
              + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
            )::int AS total_attempts
          FROM boardsesh_ticks t
          ${participantFilterEnabled ? sql`INNER JOIN eligible_sessions es ON es.session_id = t.session_id` : sql``}
          WHERE t.session_id IS NOT NULL
            ${sessionBoardFilter}
            ${sessionUserFilter}
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
        ),
        ${dailyHighlightCtes}
        ${combinedCte}
        SELECT *
        FROM combined
        ORDER BY session_last_tick DESC
        OFFSET ${offset}
        LIMIT ${limit + 1}
      `);
    } catch (err) {
      logger.error('[sessionGroupedFeed] SQL error:', err);
      throw err;
    }

    const rows = rowsFromResult<SessionFeedRow>(sessionRows);

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    // Batch enrichment keeps session cards to a fixed number of follow-up
    // queries instead of scanning ticks once per feed row.
    const sessionIds = resultRows.filter((r) => r.session_type === 'party').map((r) => r.session_id);
    const dailyHighlightKeys: DailyHighlightKey[] = resultRows
      .filter(
        (row): row is SessionFeedRow & { daily_user_id: string; daily_date: string } =>
          row.session_type === 'daily_highlight' && !!row.daily_user_id && !!row.daily_date,
      )
      .map((row) => ({ sessionId: row.session_id, userId: row.daily_user_id, day: row.daily_date }));
    const dailyHighlightTickUuids = resultRows
      .filter((row) => row.session_type === 'daily_highlight' && !!row.highlight_tick_uuid)
      .map((row) => row.highlight_tick_uuid as string);
    const filterOptions: SessionFeedFilterOptions = { boardIdFilter, userIdFilter: userId };

    const [
      participantMap,
      gradeDistMap,
      dailyGradeDistMap,
      metaMap,
      boardTypesMap,
      hardestSendMap,
      dailyHardestSendMap,
      featuredBetaMap,
    ] = await Promise.all([
      fetchParticipantsBatch(sessionIds, filterOptions),
      fetchGradeDistributionBatch(sessionIds, filterOptions),
      fetchDailyGradeDistributionBatch(dailyHighlightKeys, filterOptions),
      fetchSessionMetaBatch(sessionIds),
      fetchBoardTypesBatch(sessionIds, filterOptions),
      fetchHardestSendsBatch(sessionIds, filterOptions),
      fetchTickHighlightsByUuid(dailyHighlightTickUuids),
      fetchFeaturedBetaBatch(sessionIds, dailyHighlightKeys, filterOptions),
    ]);

    const sessions: SessionFeedItem[] = resultRows.map((row) => {
      const isDailyHighlight = row.session_type === 'daily_highlight';
      const participants = isDailyHighlight ? buildDailyParticipants(row) : (participantMap.get(row.session_id) ?? []);
      const gradeDistribution = isDailyHighlight
        ? (dailyGradeDistMap.get(row.session_id) ?? [])
        : (gradeDistMap.get(row.session_id) ?? []);
      const sessionMeta = metaMap.get(row.session_id) ?? null;
      const boardTypes = isDailyHighlight ? (row.daily_board_types ?? []) : (boardTypesMap.get(row.session_id) ?? []);
      const hardestSend = isDailyHighlight
        ? (dailyHardestSendMap.get(row.highlight_tick_uuid ?? '') ?? null)
        : (hardestSendMap.get(row.session_id) ?? null);
      const featuredBeta = featuredBetaMap.get(row.session_id) ?? null;

      const firstTime = new Date(row.session_first_tick).getTime();
      const lastTime = new Date(row.session_last_tick).getTime();
      const durationMinutes = Math.round((lastTime - firstTime) / 60000) || null;

      return {
        sessionId: row.session_id,
        sessionType: isDailyHighlight ? 'daily_highlight' : 'party',
        sessionName: isDailyHighlight ? null : sessionMeta?.name || null,
        ownerUserId: isDailyHighlight ? row.daily_user_id : sessionMeta?.ownerUserId || null,
        participants,
        totalSends: Number(row.total_sends),
        totalFlashes: Number(row.total_flashes),
        totalAttempts: Number(row.total_attempts),
        tickCount: Number(row.tick_count),
        gradeDistribution,
        boardTypes,
        hardestGrade: hardestSend?.difficultyName ?? (gradeDistribution.length > 0 ? gradeDistribution[0].grade : null),
        hardestSend,
        featuredBeta,
        socialEntityType: isDailyHighlight ? 'tick' : 'session',
        socialEntityId: isDailyHighlight ? (row.highlight_tick_uuid ?? row.session_id) : row.session_id,
        firstTickAt:
          typeof row.session_first_tick === 'object'
            ? (row.session_first_tick as unknown as Date).toISOString()
            : String(row.session_first_tick),
        lastTickAt:
          typeof row.session_last_tick === 'object'
            ? (row.session_last_tick as unknown as Date).toISOString()
            : String(row.session_last_tick),
        durationMinutes,
        goal: isDailyHighlight ? null : sessionMeta?.goal || null,
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
    ctx?: ConnectionContext,
  ): Promise<SessionDetail | null> => {
    if (!sessionId) return null;
    const dailySession = parseDailySessionId(sessionId);

    const [partySession] = dailySession
      ? []
      : await dbRead.select().from(dbSchema.boardSessions).where(eq(dbSchema.boardSessions.id, sessionId)).limit(1);

    const tickWhere = dailySession
      ? and(
          eq(dbSchema.boardseshTicks.userId, dailySession.userId),
          isNull(dbSchema.boardseshTicks.sessionId),
          sql`${dbSchema.boardseshTicks.climbedAt}::date = ${dailySession.day}::date`,
          sql`NOT EXISTS (
            SELECT 1
            FROM boardsesh_ticks session_tick
            WHERE session_tick.user_id = ${dbSchema.boardseshTicks.userId}
              AND session_tick.session_id IS NOT NULL
              AND session_tick.climbed_at::date = ${dbSchema.boardseshTicks.climbedAt}::date
          )`,
        )
      : eq(dbSchema.boardseshTicks.sessionId, sessionId);

    // Fetch ticks for this session
    const tickRows = await dbRead
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        climbDescription: dbSchema.boardClimbs.description,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
        consensusDifficulty: dbSchema.boardClimbStats.displayDifficulty,
        // Canonical climb UUID (alias-resolved) so beta links — which are stored
        // against the canonical climb — resolve for ticks pointing at an alias.
        canonicalClimbUuid: sql<string>`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid})`,
      })
      .from(dbSchema.boardseshTicks)
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs / board_climb_stats. A tick may point at an alias UUID that
      // was deduplicated away (no board_climbs row); the alias table maps it to
      // the canonical, where both the climb row and its stats live. Ticks already
      // on a canonical have no alias row, so COALESCE falls back to the tick's own
      // climb_uuid. The PK (board_type, alias_uuid) keeps the join to ≤1 row.
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbAliases.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
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
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbStats.climbUuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .where(tickWhere)
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    if (tickRows.length === 0) return null;

    // Batch-fetch tick vote counts
    const tickUuids = tickRows.map((r) => r.tick.uuid);
    const tickVoteCounts =
      tickUuids.length > 0
        ? await dbRead
            .select({
              entityId: dbSchema.voteCounts.entityId,
              upvotes: sql<number>`COALESCE(${dbSchema.voteCounts.upvotes}, 0)`,
            })
            .from(dbSchema.voteCounts)
            .where(and(eq(dbSchema.voteCounts.entityType, 'tick'), inArray(dbSchema.voteCounts.entityId, tickUuids)))
        : [];
    const tickVoteMap = new Map(tickVoteCounts.map((v) => [v.entityId, Number(v.upvotes)]));

    // Batch-fetch the beta videos attached to THIS session's own ticks in one
    // query, keyed by tickUuid so each tick reads an O(1) Map entry. Scoped by
    // the direct beta↔tick link, so the carousel shows only the crew's own clips
    // (not every community video for the climbs).
    const betaLinksByTick = await fetchBetaLinksByTick(tickUuids);

    // Build ticks (totalAttempts added below)
    const ticks: SessionDetailTick[] = tickRows.map((row) => {
      const effectiveDifficulty =
        row.tick.difficulty ?? (row.consensusDifficulty != null ? Math.round(row.consensusDifficulty) : null);
      const effectiveDifficultyName =
        row.difficultyName || (effectiveDifficulty != null ? getGradeLabel(effectiveDifficulty) : null) || null;
      return {
        uuid: row.tick.uuid,
        userId: row.tick.userId,
        climbUuid: row.tick.climbUuid,
        climbName: row.climbName || null,
        boardType: row.tick.boardType,
        layoutId: row.layoutId,
        angle: row.tick.angle,
        status: row.tick.status,
        attemptCount: row.tick.attemptCount,
        difficulty: effectiveDifficulty,
        difficultyName: effectiveDifficultyName,
        quality: row.tick.quality,
        isMirror: row.tick.isMirror ?? false,
        isBenchmark: row.tick.isBenchmark ?? false,
        isNoMatch: isNoMatchClimb(row.climbDescription),
        comment: row.tick.comment || null,
        frames: row.frames || null,
        setterUsername: row.setterUsername || null,
        climbedAt: row.tick.climbedAt,
        upvotes: tickVoteMap.get(row.tick.uuid) ?? 0,
        totalAttempts: null,
        betaLinks: betaLinksByTick.get(row.tick.uuid) ?? [],
      };
    });

    // Compute totalAttempts for each tick: sum of attemptCount since last
    // successful ascent (flash/send) by the same user on the same climb.
    // Build unique combos of (userId, climbUuid, boardType, angle) from ticks
    const comboSet = new Set<string>();
    const comboValues: Array<{
      userId: string;
      climbUuid: string;
      boardType: string;
      angle: number;
    }> = [];
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
        comboValues.map((c) => sql`(${c.userId}, ${c.climbUuid}, ${c.boardType}, ${c.angle})`),
        sql`, `,
      );

      const totalAttemptsResult = await dbRead.execute(sql`
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

      const attemptsRows = rowsFromResult<{
        user_id: string;
        climb_uuid: string;
        board_type: string;
        angle: number;
        total: number;
      }>(totalAttemptsResult);

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

    const participants = dailySession
      ? await fetchDailyDetailParticipants(dailySession.userId, totalSends, totalFlashes, totalAttempts)
      : await fetchParticipants(sessionId, userIds);
    const gradeDistribution = buildGradeDistributionFromTicks(tickRows);

    // Timestamps
    const sortedTicks = [...tickRows].sort(
      (a, b) => new Date(a.tick.climbedAt).getTime() - new Date(b.tick.climbedAt).getTime(),
    );
    const firstTickAt = sortedTicks[0].tick.climbedAt;
    const lastTickAt = sortedTicks[sortedTicks.length - 1].tick.climbedAt;
    const durationMinutes =
      Math.round((new Date(lastTickAt).getTime() - new Date(firstTickAt).getTime()) / 60000) || null;

    // Hardest grade (use effective difficulty with consensus fallback)
    const gradesSorted = tickRows
      .map((r) => {
        const effDiff = r.tick.difficulty ?? (r.consensusDifficulty != null ? Math.round(r.consensusDifficulty) : null);
        const effName = r.difficultyName || (effDiff != null ? getGradeLabel(effDiff) : null) || null;
        return { ...r, effDiff, effName };
      })
      .filter((r) => r.effName && (r.tick.status === 'flash' || r.tick.status === 'send'))
      .sort((a, b) => (b.effDiff ?? 0) - (a.effDiff ?? 0));
    const hardestGrade = gradesSorted.length > 0 ? gradesSorted[0].effName : null;

    // Vote/comment counts
    const [voteData] = dailySession
      ? []
      : await dbRead
          .select({
            upvotes: sql<number>`COALESCE(upvotes, 0)`,
            downvotes: sql<number>`COALESCE(downvotes, 0)`,
            score: sql<number>`COALESCE(score, 0)`,
          })
          .from(dbSchema.voteCounts)
          .where(and(sql`${dbSchema.voteCounts.entityType} = 'session'`, eq(dbSchema.voteCounts.entityId, sessionId)))
          .limit(1);

    const [commentData] = dailySession
      ? []
      : await dbRead
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
    const sessionName = dailySession ? null : partySession?.name || null;
    const goal = dailySession ? null : partySession?.goal || null;
    const ownerUserId = dailySession ? dailySession.userId : partySession?.createdByUserId || null;
    const viewerUserId = ctx?.isAuthenticated ? (ctx.userId ?? null) : null;
    const [healthKitWorkout] =
      viewerUserId && !dailySession
        ? await dbRead
            .select({ workoutId: dbSchema.sessionHealthKitWorkouts.workoutId })
            .from(dbSchema.sessionHealthKitWorkouts)
            .where(
              and(
                eq(dbSchema.sessionHealthKitWorkouts.sessionId, sessionId),
                eq(dbSchema.sessionHealthKitWorkouts.userId, viewerUserId),
              ),
            )
            .limit(1)
        : [];

    return {
      sessionId,
      sessionType: dailySession ? 'daily_highlight' : 'party',
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
      healthKitWorkoutId: healthKitWorkout?.workoutId ?? null,
    };
  },
};

/**
 * Fetch participant info for a session
 */
async function fetchParticipants(sessionId: string, userIds: string[]): Promise<SessionFeedParticipant[]> {
  if (userIds.length === 0) return [];

  const participantRows = await dbRead.execute(sql`
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
    WHERE t.session_id = ${sessionId}
    GROUP BY t.user_id, up.display_name, u.name, up.avatar_url, u.image
    ORDER BY sends DESC
  `);

  const participantArray = rowsFromResult<{
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    sends: number;
    flashes: number;
    attempts: number;
  }>(participantRows);
  return participantArray.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    sends: r.sends,
    flashes: r.flashes,
    attempts: r.attempts,
  }));
}

async function fetchDailyDetailParticipants(
  userId: string,
  sends: number,
  flashes: number,
  attempts: number,
): Promise<SessionFeedParticipant[]> {
  const [participant] = await dbRead
    .select({
      displayName: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
      avatarUrl: sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);

  return [
    {
      userId,
      displayName: participant?.displayName ?? null,
      avatarUrl: participant?.avatarUrl ?? null,
      sends,
      flashes,
      attempts,
    },
  ];
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
  { boardIdFilter }: SessionFeedFilterOptions,
): Promise<Map<string, SessionFeedParticipant[]>> {
  if (sessionIds.length === 0) return new Map();

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;

  const result = await dbRead.execute(sql`
    SELECT
      t.session_id,
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
    WHERE t.session_id IN ${sql`(${sql.join(
      sessionIds.map((id) => sql`${id}`),
      sql`, `,
    )})`}
      ${batchBoardFilter}
    GROUP BY t.session_id, t.user_id, up.display_name, u.name, up.avatar_url, u.image
    ORDER BY sends DESC
  `);

  const rows = rowsFromResult<{
    session_id: string;
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    sends: number;
    flashes: number;
    attempts: number;
  }>(result);

  const map = new Map<string, SessionFeedParticipant[]>();
  for (const r of rows) {
    const participants = map.get(r.session_id) ?? [];
    participants.push({
      userId: r.userId,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl,
      sends: r.sends,
      flashes: r.flashes,
      attempts: r.attempts,
    });
    map.set(r.session_id, participants);
  }
  return map;
}

/**
 * Fetch grade distributions for multiple sessions in a single query.
 * Returns a Map from sessionId to grade distribution array.
 */
async function fetchGradeDistributionBatch(
  sessionIds: string[],
  { boardIdFilter, userIdFilter }: SessionFeedFilterOptions,
): Promise<Map<string, SessionGradeDistributionItem[]>> {
  if (sessionIds.length === 0) return new Map();

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;
  const batchUserFilter = userIdFilter !== null ? sql`AND t.user_id = ${userIdFilter}` : sql``;

  const result = await dbRead.execute(sql`
    SELECT
      t.session_id,
      COALESCE(t.difficulty, ROUND(bcs.display_difficulty)::int) AS diff_num,
      COUNT(*) FILTER (WHERE t.status = 'flash')::int AS flash,
      COUNT(*) FILTER (WHERE t.status = 'send')::int AS send,
      (
        COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
        + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
      )::int AS attempt
    FROM boardsesh_ticks t
    -- Resolve a tick on a deduped-away alias UUID to the canonical, where its
    -- board_climb_stats row lives, so the consensus-grade fallback below works.
    LEFT JOIN board_climb_aliases bca ON bca.board_type = t.board_type AND bca.alias_uuid = t.climb_uuid
    LEFT JOIN board_climb_stats bcs ON bcs.climb_uuid = COALESCE(bca.canonical_uuid, t.climb_uuid) AND bcs.board_type = t.board_type AND bcs.angle = t.angle
    WHERE t.session_id IN ${sql`(${sql.join(
      sessionIds.map((id) => sql`${id}`),
      sql`, `,
    )})`}
      ${batchBoardFilter}
      ${batchUserFilter}
      AND COALESCE(t.difficulty, ROUND(bcs.display_difficulty)::int) IS NOT NULL
    GROUP BY t.session_id, diff_num
    ORDER BY diff_num DESC
  `);

  const rows = rowsFromResult<{
    session_id: string;
    diff_num: number;
    flash: number;
    send: number;
    attempt: number;
  }>(result);

  const map = new Map<string, SessionGradeDistributionItem[]>();
  for (const r of rows) {
    const grade = getGradeLabel(r.diff_num);
    if (!grade) continue;
    const distribution = map.get(r.session_id) ?? [];
    distribution.push({ grade, flash: r.flash, send: r.send, attempt: r.attempt });
    map.set(r.session_id, distribution);
  }
  return map;
}

/**
 * Fetch session metadata (name, goal, ownerUserId) for multiple sessions.
 * Returns a Map from sessionId to metadata.
 */
async function fetchSessionMetaBatch(
  sessionIds: string[],
): Promise<Map<string, { name: string | null; goal: string | null; ownerUserId: string | null }>> {
  if (sessionIds.length === 0) return new Map();

  const map = new Map<string, { name: string | null; goal: string | null; ownerUserId: string | null }>();

  const partyRows = await dbRead
    .select({
      id: dbSchema.boardSessions.id,
      name: dbSchema.boardSessions.name,
      goal: dbSchema.boardSessions.goal,
      createdByUserId: dbSchema.boardSessions.createdByUserId,
    })
    .from(dbSchema.boardSessions)
    .where(inArray(dbSchema.boardSessions.id, sessionIds));

  for (const r of partyRows) {
    map.set(r.id, { name: r.name, goal: r.goal, ownerUserId: r.createdByUserId });
  }

  return map;
}

/**
 * Fetch distinct board types for multiple sessions in a single query.
 * Returns a Map from sessionId to board types array.
 */
async function fetchBoardTypesBatch(
  sessionIds: string[],
  { boardIdFilter, userIdFilter }: SessionFeedFilterOptions,
): Promise<Map<string, string[]>> {
  if (sessionIds.length === 0) return new Map();

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;
  const batchUserFilter = userIdFilter !== null ? sql`AND t.user_id = ${userIdFilter}` : sql``;

  const result = await dbRead.execute(sql`
    SELECT
      t.session_id,
      ARRAY_AGG(DISTINCT t.board_type) AS board_types
    FROM boardsesh_ticks t
    WHERE t.session_id IN ${sql`(${sql.join(
      sessionIds.map((id) => sql`${id}`),
      sql`, `,
    )})`}
      ${batchBoardFilter}
      ${batchUserFilter}
    GROUP BY t.session_id
  `);

  const rows = rowsFromResult<{
    session_id: string;
    board_types: string[];
  }>(result);

  const map = new Map<string, string[]>();
  for (const r of rows) {
    map.set(r.session_id, r.board_types);
  }
  return map;
}

function buildDailyParticipants(row: SessionFeedRow): SessionFeedParticipant[] {
  if (!row.daily_user_id) return [];
  return [
    {
      userId: row.daily_user_id,
      displayName: row.daily_display_name,
      avatarUrl: row.daily_avatar_url,
      sends: Number(row.total_sends),
      flashes: Number(row.total_flashes),
      attempts: Number(row.total_attempts),
    },
  ];
}

type TickHighlightRow = {
  group_id?: string | null;
  uuid: string;
  userId: string;
  climbUuid: string;
  climbName: string | null;
  climbDescription: string | null;
  boardType: string;
  layoutId: number | null;
  angle: number;
  status: string;
  attemptCount: number;
  difficulty: number | null;
  consensusDifficulty: number | null;
  difficultyName: string | null;
  quality: number | null;
  isMirror: boolean | null;
  isBenchmark: boolean | null;
  comment: string | null;
  frames: string | null;
  setterUsername: string | null;
  climbedAt: string | Date;
};

function formatFeedTimestamp(timestamp: string | Date): string {
  return timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
}

function mapTickHighlightRow(row: TickHighlightRow): SessionFeedTickHighlight {
  const effectiveDifficulty =
    row.difficulty ?? (row.consensusDifficulty != null ? Math.round(row.consensusDifficulty) : null);
  const effectiveDifficultyName =
    row.difficultyName || (effectiveDifficulty != null ? getGradeLabel(effectiveDifficulty) : null) || null;

  return {
    uuid: row.uuid,
    userId: row.userId,
    climbUuid: row.climbUuid,
    climbName: row.climbName,
    boardType: row.boardType,
    layoutId: row.layoutId,
    angle: row.angle,
    status: row.status,
    attemptCount: Number(row.attemptCount),
    difficulty: effectiveDifficulty,
    difficultyName: effectiveDifficultyName,
    quality: row.quality,
    isMirror: row.isMirror ?? false,
    isBenchmark: row.isBenchmark ?? false,
    isNoMatch: isNoMatchClimb(row.climbDescription),
    comment: row.comment || null,
    frames: row.frames,
    setterUsername: row.setterUsername,
    climbedAt: formatFeedTimestamp(row.climbedAt),
  };
}

function tickHighlightSelectSql(groupIdExpression: SQL = sql`NULL::text`) {
  return sql`
    ${groupIdExpression} AS group_id,
    t.uuid,
    t.user_id AS "userId",
    t.climb_uuid AS "climbUuid",
    cf.name AS "climbName",
    cf.description AS "climbDescription",
    t.board_type AS "boardType",
    cf.layout_id AS "layoutId",
    t.angle,
    t.status,
    t.attempt_count AS "attemptCount",
    t.difficulty,
    bcs.display_difficulty AS "consensusDifficulty",
    bdg.boulder_name AS "difficultyName",
    t.quality,
    t.is_mirror AS "isMirror",
    t.is_benchmark AS "isBenchmark",
    t.comment,
    cf.frames,
    cf.setter_username AS "setterUsername",
    t.climbed_at AS "climbedAt"
  `;
}

async function fetchTickHighlightsByUuid(tickUuids: string[]): Promise<Map<string, SessionFeedTickHighlight>> {
  if (tickUuids.length === 0) return new Map();

  const result = await dbRead.execute(sql`
    SELECT
      ${tickHighlightSelectSql()}
    FROM boardsesh_ticks t
    LEFT JOIN board_climb_aliases bca ON bca.board_type = t.board_type AND bca.alias_uuid = t.climb_uuid
    LEFT JOIN board_climbs cf
      ON cf.uuid = COALESCE(bca.canonical_uuid, t.climb_uuid)
      AND cf.board_type = t.board_type
    LEFT JOIN board_difficulty_grades bdg
      ON bdg.difficulty = t.difficulty
      AND bdg.board_type = t.board_type
    LEFT JOIN board_climb_stats bcs
      ON bcs.climb_uuid = COALESCE(bca.canonical_uuid, t.climb_uuid)
      AND bcs.board_type = t.board_type
      AND bcs.angle = t.angle
    WHERE t.uuid IN ${sql`(${sql.join(
      tickUuids.map((uuid) => sql`${uuid}`),
      sql`, `,
    )})`}
  `);

  const rows = rowsFromResult<TickHighlightRow>(result);
  return new Map(rows.map((row) => [row.uuid, mapTickHighlightRow(row)]));
}

async function fetchHardestSendsBatch(
  sessionIds: string[],
  { boardIdFilter, userIdFilter }: SessionFeedFilterOptions,
): Promise<Map<string, SessionFeedTickHighlight>> {
  if (sessionIds.length === 0) return new Map();

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;
  const batchUserFilter = userIdFilter !== null ? sql`AND t.user_id = ${userIdFilter}` : sql``;

  const result = await dbRead.execute(sql`
    WITH ranked AS (
      SELECT
        t.uuid,
        t.session_id,
        ROW_NUMBER() OVER (
          PARTITION BY t.session_id
          ORDER BY COALESCE(t.difficulty, ROUND(bcs_rank.display_difficulty)::int, -1) DESC, t.climbed_at DESC, t.id DESC
        ) AS rank
      FROM boardsesh_ticks t
      LEFT JOIN board_climb_aliases bca_rank ON bca_rank.board_type = t.board_type AND bca_rank.alias_uuid = t.climb_uuid
      LEFT JOIN board_climb_stats bcs_rank
        ON bcs_rank.climb_uuid = COALESCE(bca_rank.canonical_uuid, t.climb_uuid)
        AND bcs_rank.board_type = t.board_type
        AND bcs_rank.angle = t.angle
      WHERE t.session_id IN ${sql`(${sql.join(
        sessionIds.map((id) => sql`${id}`),
        sql`, `,
      )})`}
        ${batchBoardFilter}
        ${batchUserFilter}
        AND t.status IN ('flash', 'send')
    )
    SELECT
      ${tickHighlightSelectSql(sql`ranked.session_id`)}
    FROM ranked
    INNER JOIN boardsesh_ticks t ON t.uuid = ranked.uuid
    LEFT JOIN board_climb_aliases bca ON bca.board_type = t.board_type AND bca.alias_uuid = t.climb_uuid
    LEFT JOIN board_climbs cf
      ON cf.uuid = COALESCE(bca.canonical_uuid, t.climb_uuid)
      AND cf.board_type = t.board_type
    LEFT JOIN board_difficulty_grades bdg
      ON bdg.difficulty = t.difficulty
      AND bdg.board_type = t.board_type
    LEFT JOIN board_climb_stats bcs
      ON bcs.climb_uuid = COALESCE(bca.canonical_uuid, t.climb_uuid)
      AND bcs.board_type = t.board_type
      AND bcs.angle = t.angle
    WHERE ranked.rank = 1
  `);

  const rows = rowsFromResult<TickHighlightRow>(result);
  const map = new Map<string, SessionFeedTickHighlight>();
  for (const row of rows) {
    if (!row.group_id) continue;
    map.set(row.group_id, mapTickHighlightRow(row));
  }
  return map;
}

async function fetchDailyGradeDistributionBatch(
  dailyHighlightKeys: DailyHighlightKey[],
  { boardIdFilter }: SessionFeedFilterOptions,
): Promise<Map<string, SessionGradeDistributionItem[]>> {
  if (dailyHighlightKeys.length === 0) return new Map();

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;

  const valuesSql = sql.join(
    dailyHighlightKeys.map((key) => sql`(${key.sessionId}, ${key.userId}, ${key.day}::date)`),
    sql`, `,
  );

  const result = await dbRead.execute(sql`
    WITH keys(session_id, user_id, day) AS (
      VALUES ${valuesSql}
    )
    SELECT
      keys.session_id,
      COALESCE(t.difficulty, ROUND(bcs.display_difficulty)::int) AS diff_num,
      COUNT(*) FILTER (WHERE t.status = 'flash')::int AS flash,
      COUNT(*) FILTER (WHERE t.status = 'send')::int AS send,
      (
        COALESCE(SUM(GREATEST(t.attempt_count - 1, 0)) FILTER (WHERE t.status = 'send'), 0)
        + COALESCE(SUM(t.attempt_count) FILTER (WHERE t.status = 'attempt'), 0)
      )::int AS attempt
    FROM keys
    INNER JOIN boardsesh_ticks t
      ON t.user_id = keys.user_id
      AND t.climbed_at::date = keys.day
      AND t.session_id IS NULL
    LEFT JOIN board_climb_aliases bca ON bca.board_type = t.board_type AND bca.alias_uuid = t.climb_uuid
    LEFT JOIN board_climb_stats bcs
      ON bcs.climb_uuid = COALESCE(bca.canonical_uuid, t.climb_uuid)
      AND bcs.board_type = t.board_type
      AND bcs.angle = t.angle
    WHERE COALESCE(t.difficulty, ROUND(bcs.display_difficulty)::int) IS NOT NULL
      ${batchBoardFilter}
    GROUP BY keys.session_id, diff_num
    ORDER BY diff_num DESC
  `);

  const rows = rowsFromResult<{
    session_id: string;
    diff_num: number;
    flash: number;
    send: number;
    attempt: number;
  }>(result);

  const map = new Map<string, SessionGradeDistributionItem[]>();
  for (const row of rows) {
    const grade = getGradeLabel(row.diff_num);
    if (!grade) continue;
    const distribution = map.get(row.session_id) ?? [];
    distribution.push({ grade, flash: row.flash, send: row.send, attempt: row.attempt });
    map.set(row.session_id, distribution);
  }
  return map;
}

function mapBetaLinkRow(row: BetaLinkRow): BetaLinksGqlRow {
  return {
    climbUuid: row.climbUuid,
    link: row.link,
    foreignUsername: row.foreignUsername,
    angle: row.angle,
    thumbnail: row.thumbnail,
    isListed: row.isListed,
    createdAt: row.createdAt,
    tickUuid: row.betaLinkTickUuid ?? null,
    boardId: row.boardId ?? null,
  };
}

/**
 * Batch-fetch beta videos attached to the SESSION'S OWN ticks, for the
 * session-detail beta carousel.
 *
 * Runs ONE query against board_beta_links filtered by `tick_uuid IN (<the
 * session's tick uuids>)` — the direct beta↔tick link added in migration
 * `0128_direct_beta_tick_links.sql`. Because a beta link's `tick_uuid` resolves
 * to exactly one ascent (one user, one session), this returns ONLY the clips the
 * session's own climbers attached to their sends here — not every community clip
 * for the climbs. `board_beta_links_tick_uuid_unique` means at most one clip per
 * tick. Keeps the is_listed + KayaClimb gates.
 *
 * Returns a Map keyed by `tickUuid`, so each tick reads an O(1) entry. The
 * carousel attributes each clip to the participant who logged that tick.
 *
 * Community beta (every shareable clip for a climb, regardless of who posted it)
 * is intentionally NOT surfaced here — it lives on the climb's play-drawer beta
 * list, where "all the beta for this climb" is the correct scope.
 */
async function fetchBetaLinksByTick(tickUuids: string[]): Promise<Map<string, BetaLinksGqlRow[]>> {
  const map = new Map<string, BetaLinksGqlRow[]>();
  if (tickUuids.length === 0) return map;

  const betaRows = await dbRead
    .select({
      climbUuid: dbSchema.boardBetaLinks.climbUuid,
      link: dbSchema.boardBetaLinks.link,
      foreignUsername: dbSchema.boardBetaLinks.foreignUsername,
      angle: dbSchema.boardBetaLinks.angle,
      thumbnail: dbSchema.boardBetaLinks.thumbnail,
      isListed: dbSchema.boardBetaLinks.isListed,
      createdAt: dbSchema.boardBetaLinks.createdAt,
      betaLinkTickUuid: dbSchema.boardBetaLinks.tickUuid,
      boardId: dbSchema.boardBetaLinks.boardId,
    })
    .from(dbSchema.boardBetaLinks)
    .where(
      and(
        inArray(dbSchema.boardBetaLinks.tickUuid, tickUuids),
        eq(dbSchema.boardBetaLinks.isListed, true),
        // Match the featured-beta KayaClimb exclusion: drop links pointing at
        // kayaclimb.com (and any subdomain), which aren't shareable video beta.
        sql`${dbSchema.boardBetaLinks.link} !~* '^https?://([a-z0-9-]+\\.)*kayaclimb\\.com/'`,
      ),
    )
    .orderBy(desc(dbSchema.boardBetaLinks.createdAt));

  for (const row of betaRows) {
    const tickUuid = row.betaLinkTickUuid;
    if (!tickUuid) continue;
    const existing = map.get(tickUuid);
    const mapped = mapBetaLinkRow(row);
    if (existing) {
      existing.push(mapped);
    } else {
      map.set(tickUuid, [mapped]);
    }
  }
  return map;
}

async function fetchFeaturedBetaBatch(
  sessionIds: string[],
  dailyHighlightKeys: DailyHighlightKey[],
  filterOptions: SessionFeedFilterOptions,
): Promise<Map<string, SessionFeedBetaHighlight>> {
  const [sessionBetaRows, dailyBetaRows] = await Promise.all([
    fetchSessionFeaturedBetaRows(sessionIds, filterOptions),
    fetchDailyFeaturedBetaRows(dailyHighlightKeys, filterOptions),
  ]);
  const betaRows = [...sessionBetaRows, ...dailyBetaRows];
  if (betaRows.length === 0) return new Map();

  const tickHighlights = await fetchTickHighlightsByUuid([...new Set(betaRows.map((row) => row.tickUuid))]);
  const map = new Map<string, SessionFeedBetaHighlight>();
  for (const row of betaRows) {
    const tick = tickHighlights.get(row.tickUuid);
    if (!tick) continue;
    map.set(row.groupId, { tick, betaLink: mapBetaLinkRow(row) });
  }
  return map;
}

function betaCandidateJoinSql() {
  return sql`
    LEFT JOIN board_climb_aliases bca_video
      ON bca_video.board_type = t.board_type
      AND bca_video.alias_uuid = t.climb_uuid
    INNER JOIN board_beta_links bl
      ON bl.board_type = t.board_type
      AND bl.climb_uuid = COALESCE(bca_video.canonical_uuid, t.climb_uuid)
      AND (
        bl.tick_uuid = t.uuid
        OR (
          bl.tick_uuid IS NULL
          AND bl.created_by_user_id = t.user_id
          AND (bl.angle IS NULL OR bl.angle = t.angle)
        )
      )
      AND bl.is_listed IS TRUE
      AND bl.link !~* '^https?://([a-z0-9-]+\\.)*kayaclimb\\.com/'
  `;
}

function betaCandidateRankSql(partitionExpression: SQL) {
  return sql`
    ROW_NUMBER() OVER (
      PARTITION BY ${partitionExpression}
      ORDER BY
        (bl.tick_uuid = t.uuid) DESC,
        COALESCE(t.difficulty, ROUND(bcs_beta.display_difficulty)::int, -1) DESC,
        t.climbed_at DESC,
        t.id DESC,
        bl.created_at DESC NULLS LAST
    ) AS rank
  `;
}

async function fetchSessionFeaturedBetaRows(
  sessionIds: string[],
  { boardIdFilter, userIdFilter }: SessionFeedFilterOptions,
): Promise<FeaturedBetaRow[]> {
  if (sessionIds.length === 0) return [];

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;
  const batchUserFilter = userIdFilter !== null ? sql`AND t.user_id = ${userIdFilter}` : sql``;

  const result = await dbRead.execute(sql`
    WITH ranked AS (
      SELECT
        t.session_id AS "groupId",
        t.uuid AS "tickUuid",
        bl.climb_uuid AS "climbUuid",
        bl.link,
        bl.foreign_username AS "foreignUsername",
        bl.angle,
        bl.thumbnail,
        bl.is_listed AS "isListed",
        bl.created_at AS "createdAt",
        bl.tick_uuid AS "betaLinkTickUuid",
        bl.board_id AS "boardId",
        ${betaCandidateRankSql(sql`t.session_id`)}
      FROM boardsesh_ticks t
      ${betaCandidateJoinSql()}
      LEFT JOIN board_climb_aliases bca_beta ON bca_beta.board_type = t.board_type AND bca_beta.alias_uuid = t.climb_uuid
      LEFT JOIN board_climb_stats bcs_beta
        ON bcs_beta.climb_uuid = COALESCE(bca_beta.canonical_uuid, t.climb_uuid)
        AND bcs_beta.board_type = t.board_type
        AND bcs_beta.angle = t.angle
      WHERE t.session_id IN ${sql`(${sql.join(
        sessionIds.map((id) => sql`${id}`),
        sql`, `,
      )})`}
        ${batchBoardFilter}
        ${batchUserFilter}
        AND t.status IN ('flash', 'send')
    )
    SELECT *
    FROM ranked
    WHERE rank = 1
  `);

  return rowsFromResult<FeaturedBetaRow>(result);
}

async function fetchDailyFeaturedBetaRows(
  dailyHighlightKeys: DailyHighlightKey[],
  { boardIdFilter }: SessionFeedFilterOptions,
): Promise<FeaturedBetaRow[]> {
  if (dailyHighlightKeys.length === 0) return [];

  const batchBoardFilter = boardIdFilter !== null ? sql`AND t.board_id = ${boardIdFilter}` : sql``;
  const valuesSql = sql.join(
    dailyHighlightKeys.map((key) => sql`(${key.sessionId}, ${key.userId}, ${key.day}::date)`),
    sql`, `,
  );

  const result = await dbRead.execute(sql`
    WITH keys(session_id, user_id, day) AS (
      VALUES ${valuesSql}
    ),
    ranked AS (
      SELECT
        keys.session_id AS "groupId",
        t.uuid AS "tickUuid",
        bl.climb_uuid AS "climbUuid",
        bl.link,
        bl.foreign_username AS "foreignUsername",
        bl.angle,
        bl.thumbnail,
        bl.is_listed AS "isListed",
        bl.created_at AS "createdAt",
        bl.tick_uuid AS "betaLinkTickUuid",
        bl.board_id AS "boardId",
        ${betaCandidateRankSql(sql`keys.session_id`)}
      FROM keys
      INNER JOIN boardsesh_ticks t
        ON t.user_id = keys.user_id
        AND t.climbed_at::date = keys.day
        AND t.session_id IS NULL
      ${betaCandidateJoinSql()}
      LEFT JOIN board_climb_aliases bca_beta ON bca_beta.board_type = t.board_type AND bca_beta.alias_uuid = t.climb_uuid
      LEFT JOIN board_climb_stats bcs_beta
        ON bcs_beta.climb_uuid = COALESCE(bca_beta.canonical_uuid, t.climb_uuid)
        AND bcs_beta.board_type = t.board_type
        AND bcs_beta.angle = t.angle
      WHERE t.status IN ('flash', 'send')
        ${batchBoardFilter}
    )
    SELECT *
    FROM ranked
    WHERE rank = 1
  `);

  return rowsFromResult<FeaturedBetaRow>(result);
}
