// Board-presence durable stats: computation + live push.
//
// Stats (sends / climbers / hardest / top grade) are derived from
// `boardsesh_ticks` stamped with a board_id. The `boardPresenceStats` query
// reads them on demand; `publishBoardStats` recomputes and pushes a
// `BoardStatsUpdated` event over the same `boardNowPlaying` subscription as
// climb events, so every watcher's tiles update live the moment a tick lands —
// no client re-fetch. Both go through the same computation so the live push and
// a later cold fetch never disagree.

import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import type { BoardPresenceHardestSend, BoardPresenceStats } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub/index';
import { redisClientManager } from '../../../redis/client';
import { logger } from '../../../utils/logger';

type BoardPresenceStatsRow = {
  climbsSentCount: number;
  distinctClimbersCount: number;
  hardestGrade: string | null;
  topGrade: string | null;
  lastSentAt: string | Date | null;
  hardestSendClimbUuid: string | null;
  name: string | null;
  grade: string | null;
  sentByUserId: string | null;
  sentByDisplayName: string | null;
  sentByAvatarUrl: string | null;
  sentAt: string | Date | null;
};

function parsePostgresUtcTimestamp(timestamp: string | Date | null | undefined): string | null {
  if (!timestamp) return null;
  if (timestamp instanceof Date) return timestamp.toISOString();
  const isoLikeTimestamp = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
  const zonedTimestamp = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoLikeTimestamp) ? isoLikeTimestamp : `${isoLikeTimestamp}Z`;
  return new Date(zonedTimestamp).toISOString();
}

function toHardestSend(row: BoardPresenceStatsRow | undefined): BoardPresenceHardestSend | null {
  if (!row?.hardestSendClimbUuid || !row.grade || !row.sentByUserId) return null;
  const sentAt = parsePostgresUtcTimestamp(row.sentAt);
  if (!sentAt) return null;
  return {
    climbUuid: row.hardestSendClimbUuid,
    name: row.name,
    grade: row.grade,
    sentByUserId: row.sentByUserId,
    sentByDisplayName: row.sentByDisplayName,
    sentByAvatarUrl: row.sentByAvatarUrl,
    sentAt,
  };
}

/**
 * Compute a board's durable wall stats from `boardsesh_ticks`. The single
 * source of truth for both the `boardPresenceStats` query and the live push.
 */
export async function computeBoardPresenceStats(boardId: number, boardType: string): Promise<BoardPresenceStats> {
  const rows = await db.execute(sql<BoardPresenceStatsRow>`
    WITH tick_difficulties AS (
      SELECT
        t.id,
        t.user_id,
        t.board_type,
        t.climb_uuid,
        COALESCE(a.canonical_uuid, t.climb_uuid) AS canonical_climb_uuid,
        t.climbed_at,
        t.status,
        COALESCE(t.difficulty, ROUND(s.display_difficulty)::int) AS difficulty
      FROM boardsesh_ticks t
      LEFT JOIN board_climb_aliases a
        ON a.board_type = t.board_type
       AND a.alias_uuid = t.climb_uuid
      LEFT JOIN board_climb_stats s
        ON s.board_type = t.board_type
       AND s.climb_uuid = COALESCE(a.canonical_uuid, t.climb_uuid)
       AND s.angle = t.angle
      WHERE t.board_id = ${boardId}
    ),
    aggregate_stats AS (
      SELECT
        (COUNT(DISTINCT canonical_climb_uuid) FILTER (WHERE status IN ('send', 'flash')))::int AS climbs_sent_count,
        COUNT(DISTINCT user_id)::int AS distinct_climbers_count,
        MAX(climbed_at) FILTER (WHERE status IN ('send', 'flash')) AS last_sent_at,
        MAX(difficulty) FILTER (WHERE status IN ('send', 'flash')) AS hardest_difficulty
      FROM tick_difficulties
    ),
    top_grade AS (
      SELECT difficulty
      FROM tick_difficulties
      WHERE status IN ('send', 'flash')
        AND difficulty IS NOT NULL
      GROUP BY difficulty
      ORDER BY COUNT(*) DESC, difficulty DESC
      LIMIT 1
    ),
    hardest_send AS (
      SELECT
        id,
        user_id,
        board_type,
        canonical_climb_uuid,
        climbed_at,
        difficulty
      FROM tick_difficulties
      WHERE status IN ('send', 'flash')
        AND difficulty IS NOT NULL
      ORDER BY difficulty DESC, climbed_at ASC, id ASC
      LIMIT 1
    )
    SELECT
      stats.climbs_sent_count AS "climbsSentCount",
      stats.distinct_climbers_count AS "distinctClimbersCount",
      COALESCE(hardest_grade.boulder_name, stats.hardest_difficulty::text) AS "hardestGrade",
      COALESCE(top_grade_name.boulder_name, top_grade.difficulty::text) AS "topGrade",
      stats.last_sent_at AS "lastSentAt",
      hardest_send.canonical_climb_uuid AS "hardestSendClimbUuid",
      c.name AS "name",
      COALESCE(hardest_send_grade.boulder_name, hardest_send.difficulty::text) AS "grade",
      hardest_send.user_id AS "sentByUserId",
      COALESCE(p.display_name, u.name) AS "sentByDisplayName",
      COALESCE(p.avatar_url, u.image) AS "sentByAvatarUrl",
      hardest_send.climbed_at AS "sentAt"
    FROM aggregate_stats stats
    LEFT JOIN board_difficulty_grades hardest_grade
      ON hardest_grade.board_type = ${boardType}
     AND hardest_grade.difficulty = stats.hardest_difficulty
    LEFT JOIN top_grade
      ON TRUE
    LEFT JOIN board_difficulty_grades top_grade_name
      ON top_grade_name.board_type = ${boardType}
     AND top_grade_name.difficulty = top_grade.difficulty
    LEFT JOIN hardest_send
      ON TRUE
    LEFT JOIN board_climbs c
      ON c.board_type = hardest_send.board_type
     AND c.uuid = hardest_send.canonical_climb_uuid
    LEFT JOIN board_difficulty_grades hardest_send_grade
      ON hardest_send_grade.board_type = hardest_send.board_type
     AND hardest_send_grade.difficulty = hardest_send.difficulty
    LEFT JOIN users u
      ON u.id = hardest_send.user_id
    LEFT JOIN user_profiles p
      ON p.user_id = hardest_send.user_id
  `);
  const stats = rows[0] as BoardPresenceStatsRow | undefined;

  return {
    climbsSentCount: Number(stats?.climbsSentCount ?? 0),
    distinctClimbersCount: Number(stats?.distinctClimbersCount ?? 0),
    hardestGrade: stats?.hardestGrade ?? null,
    hardestSend: toHardestSend(stats),
    topGrade: stats?.topGrade ?? null,
    lastSentAt: parsePostgresUtcTimestamp(stats?.lastSentAt),
  };
}

/**
 * Recompute a board's stats and push them to its live `boardNowPlaying` feed as
 * a `BoardStatsUpdated` event. Reached only through `queueBoardStatsPublish`,
 * which serializes calls per board — so the compute→seq ordering here is safe:
 * the seq that labels a snapshot is allocated within the same (non-overlapping)
 * execution that read it, so a higher seq always carries an equal-or-newer
 * snapshot. The reducer relies on exactly that invariant.
 *
 * Never throws: a failed stats push must not fail the tick that triggered it.
 */
export async function publishBoardStats(boardId: number, boardType: string): Promise<void> {
  try {
    const stats = await computeBoardPresenceStats(boardId, boardType);
    const seq = await pubsub.nextBoardSeq(String(boardId));
    pubsub.publishBoardPresenceEvent(String(boardId), {
      __typename: 'BoardStatsUpdated',
      stats,
      seq,
    });
  } catch (error) {
    logger.warn(`[board-presence] publishBoardStats failed for board ${boardId}: ${String(error)}`);
  }
}

const STATS_DEBOUNCE_MS = 2000;
const STATS_DEBOUNCE_REDIS_PREFIX = 'boardsesh:debounce:board-stats:';

// Local timers, one per board. Each new tick clears and re-arms the board's
// timer, so only one publish is ever pending per board (trailing edge).
const pendingBoardStats = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Debounced entry point for the board-stats push. A burst of ticks on one wall
 * (two climbers, or one climber logging fast) collapses into a single trailing
 * recompute+publish per board, which:
 *   1. removes redundant 2-query recomputes per tick, and
 *   2. SERIALIZES the publish per board, so two ticks can never run two
 *      concurrent compute→seq→publish cycles and pair a staler snapshot with a
 *      higher seq (which would regress the live tiles). One pending timer per
 *      board guarantees one execution at a time.
 *
 * Multi-instance: a Redis nonce (last writer wins) makes only the instance that
 * received the latest tick actually publish, so the global feed still sees one
 * monotonic push per window. Falls back to local-only debounce without Redis.
 * Mirrors `publishDebouncedSessionStats` / `queueClimbStatsRecompute`.
 */
export function queueBoardStatsPublish(boardId: number, boardType: string): void {
  const existing = pendingBoardStats.get(boardId);
  if (existing) {
    clearTimeout(existing);
  }

  const nonce = randomUUID();
  const redisKey = `${STATS_DEBOUNCE_REDIS_PREFIX}${boardId}`;

  if (redisClientManager.isRedisConnected()) {
    const { publisher } = redisClientManager.getClients();
    publisher.set(redisKey, nonce, 'PX', STATS_DEBOUNCE_MS + 500).catch((error) => {
      logger.error(`[board-presence] board-stats debounce Redis SET failed for board ${boardId}:`, error);
    });
  }

  pendingBoardStats.set(
    boardId,
    setTimeout(async () => {
      pendingBoardStats.delete(boardId);

      // Multi-instance: only the instance holding the latest nonce publishes.
      if (redisClientManager.isRedisConnected()) {
        try {
          const { publisher } = redisClientManager.getClients();
          const current = await publisher.get(redisKey);
          if (current !== nonce) {
            return;
          }
          await publisher.del(redisKey);
        } catch (error) {
          logger.error(
            `[board-presence] board-stats debounce Redis GET failed for board ${boardId}, publishing anyway:`,
            error,
          );
          // Fall through: a duplicate push is harmless (seq-gated), a drop is not.
        }
      }

      await publishBoardStats(boardId, boardType);
    }, STATS_DEBOUNCE_MS),
  );
}
