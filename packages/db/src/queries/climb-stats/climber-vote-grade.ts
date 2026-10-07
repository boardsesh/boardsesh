import { sql, type SQL } from 'drizzle-orm';

/**
 * The grade rule for climbs whose grade comes from the people who climbed them,
 * one vote each (#5971).
 *
 * A climb on one of these boards takes its grade, in this order, from:
 *
 *  1. an approved community grade (`climb_community_status.community_grade`, the
 *     effect of an approved grade proposal). It is pinned: ticks do not move it
 *     until a newer proposal does;
 *  2. otherwise the climbers' vote: the average, over each climber, of the
 *     grade on their LATEST graded flash/send at the key. A climber who logs the
 *     climb five times still votes once. The first ascent is a vote of one, which
 *     is how "the first ascent sets the grade" works: there is no separate column;
 *  3. otherwise a grade the setter seeded before the first ascent graded it
 *     (`tick_graded_at IS NULL`), which older apps still send. The first graded
 *     send replaces it, and once a vote has stamped the row the seed is gone: a
 *     row whose last graded send is deleted goes back to ungraded.
 *
 * Spray only today. Other boards are tracked in #6192: widening it is adding the
 * board to {@link CLIMBER_VOTE_GRADE_BOARDS}, nothing else.
 */
export const CLIMBER_VOTE_GRADE_BOARDS = ['spray'] as const;

/** Does `boardTypeSql` name a board whose grade is the climbers' vote? */
export function climberVoteGradeAppliesSql(boardTypeSql: SQL): SQL {
  return sql`(${boardTypeSql} IN (${sql.join(
    CLIMBER_VOTE_GRADE_BOARDS.map((board) => sql`${board}`),
    sql`, `,
  )}))`;
}

type StatsKeySql = { boardType: SQL; climbUuid: SQL; angle: SQL };

/**
 * One vote per climber: the average of each climber's latest graded flash/send
 * at the key (max climbed_at, tie-break max id), NULL when nobody has graded it.
 * Detached ticks are out, as everywhere else in the recompute. Not filtered by
 * the holds epoch, for the same reason the tick average is not (see recompute.ts).
 */
export function climberVoteAverageSql(key: StatsKeySql): SQL {
  return sql`(
    SELECT AVG(latest_vote.difficulty)
      FROM (
        SELECT DISTINCT ON (vote_tick.user_id) vote_tick.difficulty
          FROM boardsesh_ticks vote_tick
         WHERE vote_tick.board_type = ${key.boardType}
           AND vote_tick.climb_uuid = ${key.climbUuid}
           AND vote_tick.angle      = ${key.angle}
           AND vote_tick.status IN ('flash','send')
           AND vote_tick.difficulty > 1
           AND vote_tick.kilter_detached_at IS NULL
         ORDER BY vote_tick.user_id, vote_tick.climbed_at DESC, vote_tick.id DESC
      ) latest_vote
  )`;
}

/**
 * The approved community grade at the key, as a difficulty id: the proposal's
 * label (`Grade.name`, e.g. "6b/V4") matched against the board's own scale.
 * NULL when there is none, or when the label is not on the scale.
 */
export function pinnedCommunityGradeSql(key: StatsKeySql): SQL {
  return sql`(
    SELECT pinned_grade.difficulty::double precision
      FROM climb_community_status pinned_status
      JOIN board_difficulty_grades pinned_grade
        ON pinned_grade.board_type = pinned_status.board_type
       AND LOWER(pinned_grade.boulder_name) = LOWER(TRIM(pinned_status.community_grade))
     WHERE pinned_status.board_type = ${key.boardType}
       AND pinned_status.climb_uuid = ${key.climbUuid}
       AND pinned_status.angle      = ${key.angle}
     ORDER BY pinned_grade.difficulty
     LIMIT 1
  )`;
}

/**
 * The grade the rule above gives, given the current row alias `s` (its seed and
 * its marker). Used for both `display_difficulty` and `difficulty_average`.
 */
export function climberVoteGradeSql(key: StatsKeySql, statsAlias: 's'): SQL {
  const alias = sql.raw(statsAlias);
  return sql`COALESCE(
    ${pinnedCommunityGradeSql(key)},
    ${climberVoteAverageSql(key)},
    CASE WHEN ${alias}.tick_graded_at IS NULL THEN ${alias}.display_difficulty END
  )`;
}

/**
 * `tick_graded_at` under the rule: stamped while a pinned grade or a vote
 * decides the grade, NULL otherwise. A surviving seed keeps its NULL, which is
 * what lets the next vote replace it.
 */
export function climberVoteGradedAtSql(key: StatsKeySql): SQL {
  return sql`CASE
    WHEN COALESCE(${pinnedCommunityGradeSql(key)}, ${climberVoteAverageSql(key)}) IS NULL THEN NULL
    ELSE (now() AT TIME ZONE 'UTC')
  END`;
}

/** Is `boardType` a board whose grade is the climbers' vote? */
export function climberVoteGradeApplies(boardType: string): boolean {
  return (CLIMBER_VOTE_GRADE_BOARDS as readonly string[]).includes(boardType);
}

/**
 * The leading CASE arms the rule adds to the recompute's grade columns, or
 * empty arms when none of `boardTypes` (the boards of the statement's keys) is
 * a climbers'-vote board. The arms name `climb_community_status` and
 * `board_difficulty_grades`, and Postgres checks table privileges when it plans
 * a statement, not when a CASE arm runs. Leaving them out keeps a Kilter or
 * Aurora recompute off those tables, so it runs as a worker role that has not
 * been granted them yet (a worker image can start before the migrator grants;
 * docs/background-workers.md).
 */
export function climberVoteGradeArms(
  boardTypes: readonly string[],
  key: StatsKeySql,
  statsAlias: 's',
): { grade: SQL; gradedAt: SQL } {
  if (!boardTypes.some(climberVoteGradeApplies)) return { grade: sql``, gradedAt: sql`` };
  const applies = climberVoteGradeAppliesSql(key.boardType);
  return {
    grade: sql`WHEN ${applies} THEN ${climberVoteGradeSql(key, statsAlias)}`,
    gradedAt: sql`WHEN ${applies} THEN ${climberVoteGradedAtSql(key)}`,
  };
}
