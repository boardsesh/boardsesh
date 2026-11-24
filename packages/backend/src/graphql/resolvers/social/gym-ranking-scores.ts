import { sql, type SQL } from 'drizzle-orm';
import { contentVisibilityCondition } from '@boardsesh/db/queries';
import { getGradesForBoard } from '@boardsesh/board-config';
import type { GymClimbRankingMode } from '@boardsesh/shared-schema';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import { reportingCommentAudience } from './gym-comment-attribution';
import { currentReferenceDifficultySql, currentReferenceGradeJoins } from './gym-inventory';
import {
  identifiedActor,
  reportingActivityInWindowSql,
  reportingActivitySql,
  type GymReportingScope,
} from './gym-reporting';

const group = sql`physical_board_uuid, board_type, climb_uuid, angle, is_mirror`;
const variantColumns = sql`activity.physical_board_uuid, activity.board_type, activity.climb_uuid,
  activity.angle, activity.is_mirror`;
const utc = (time: SQL) => sql`to_char(${time} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const scoreColumns = {
  sendCount: sql`NULL::int`,
  senderCount: sql`NULL::int`,
  qualityMean: sql`NULL::numeric`,
  voterCount: sql`NULL::int`,
  commentCount: sql`NULL::int`,
  authorCount: sql`NULL::int`,
  gradeDelta: sql`NULL::numeric`,
  firstKnownAvailableAt: sql`NULL::text`,
  lastSendAt: sql`NULL::text`,
  lastSendEndAt: sql`NULL::text`,
  lastSendDate: sql`NULL::text`,
  knownLifetimeDays: sql`NULL::numeric`,
  knownWindowDays: sql`NULL::numeric`,
  sendsPerDay: sql`NULL::numeric`,
};

function projections(overrides: Partial<typeof scoreColumns>): SQL {
  return sql.join(
    Object.entries({ ...scoreColumns, ...overrides }).map(([name, value]) => sql`${value} AS ${sql.identifier(name)}`),
    sql`, `,
  );
}

export function gradeScaleSql(scope: GymReportingScope): SQL {
  const values = [...new Set(scope.activityBoards.map(({ boardType }) => boardType))].flatMap((boardType) =>
    isValidBoardName(boardType)
      ? getGradesForBoard(boardType).map(
          ({ difficulty_id: difficulty }, index) => sql`(${boardType}::text, ${difficulty}::int, ${index}::int)`,
        )
      : [],
  );
  return values.length
    ? sql`VALUES ${sql.join(values, sql`, `)}`
    : sql`SELECT NULL::text, NULL::int, NULL::int WHERE false`;
}

type VoteMode = Extract<GymClimbRankingMode, 'TOP_RATED' | 'GRADE_FEEDBACK'>;

/** Admit only votes that can contribute before projecting any author calendar. */
export function rankingVoteActivity(scope: GymReportingScope, mode: VoteMode, eligibility: SQL): SQL {
  const rating = mode === 'TOP_RATED';
  const metric = rating ? 'QUALITY' : 'DIFFICULTY';
  return reportingActivitySql(scope, {
    start: scope.current.startAt,
    end: scope.asOf,
    ticksOnly: true,
    identifiedOnly: true,
    candidateTickWhen: sql`
      tick.kilter_detached_at IS NULL AND tick.reporting_climbed_at = tick.climbed_at
      AND tick.reporting_time_precision IN ('instant', 'day')
      AND EXISTS (
        SELECT 1 FROM LATERAL (
          SELECT tick.board_id, tick.board_type, coalesce(tick_alias.canonical_uuid, tick.climb_uuid) AS climb_uuid,
            tick.angle, tick.is_mirror
        ) activity
        JOIN gym_reporting_tick_votes proof ON proof.tick_id = tick.id AND proof.metric = ${metric}
          AND proof.attested_value = ${rating ? sql`tick.quality` : sql`tick.difficulty`}
        ${
          rating
            ? sql``
            : sql`
          JOIN vote_grade_scale scale ON scale.board_type = activity.board_type AND scale.difficulty = proof.attested_value
        `
        }
        ${eligibility}
        ${
          rating
            ? sql``
            : sql`
          AND EXISTS (
            SELECT 1 FROM LATERAL (SELECT activity.board_type, activity.climb_uuid, activity.angle) variant
            ${currentReferenceGradeJoins()}
            JOIN vote_grade_scale reference ON reference.board_type = variant.board_type
              AND reference.difficulty = ${currentReferenceDifficultySql()}::int
          )
        `
        }
      )
    `,
  });
}

export function tickRankScores(scope: GymReportingScope, mode: 'MOST_SENT' | VoteMode, eligibility: SQL) {
  const window = reportingActivityInWindowSql(scope.current);
  if (mode === 'MOST_SENT')
    return sql`
    SELECT ${variantColumns}, min(activity.board_id) AS board_id,
      ${projections({ sendCount: sql`count(*)::int`, senderCount: sql`count(DISTINCT activity.actor_id)::int` })}
    FROM (${reportingActivitySql(scope, {
      start: scope.current.startAt,
      end: scope.asOf,
      sendsOnly: true,
    })}) activity ${eligibility} AND ${window}
    GROUP BY ${variantColumns}
  `;
  const rating = mode === 'TOP_RATED';
  const metric = rating ? 'QUALITY' : 'DIFFICULTY';
  return sql`
    WITH voted AS MATERIALIZED (
      SELECT ${variantColumns}, activity.board_id, activity.actor_id, activity.activity_id::bigint AS native_id,
        activity.occurred_at, activity.possible_end_at,
        coalesce(activity.occurred_at, activity.possible_start_at) AS possible_start_at,
        ${rating ? sql`proof.attested_value` : sql`scale.grade_step`} AS value
      FROM vote_activity activity
      JOIN gym_reporting_tick_votes proof ON proof.tick_id = activity.activity_id::bigint AND proof.metric = ${metric}
      ${rating ? sql`` : sql`JOIN vote_grade_scale scale ON scale.board_type = activity.board_type AND scale.difficulty = proof.attested_value`}
      WHERE ${window}
    ),
    possible_latest AS (
      SELECT *, max(possible_start_at) OVER voter AS latest_start,
        max(native_id) OVER (PARTITION BY ${group}, actor_id, occurred_at) AS latest_same_instant
      FROM voted WINDOW voter AS (PARTITION BY ${group}, actor_id)
    ),
    resolved_votes AS (
      SELECT ${group}, min(board_id) AS board_id, actor_id, min(value) AS value
      FROM possible_latest
      WHERE (occurred_at = latest_start AND native_id = latest_same_instant)
        OR (occurred_at IS NULL AND possible_end_at > latest_start)
      GROUP BY ${group}, actor_id HAVING min(value) = max(value)
    ),
    grouped_votes AS (
      SELECT ${group}, min(board_id) AS board_id, count(*)::int AS voters,
        ${rating ? sql`avg(value)` : sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::numeric`} AS score
      FROM resolved_votes GROUP BY ${group} HAVING count(*) >= 5
    )
    SELECT variant.physical_board_uuid, variant.board_type, variant.climb_uuid, variant.angle, variant.is_mirror,
      variant.board_id, ${projections(
        rating
          ? {
              qualityMean: sql`variant.score`,
              voterCount: sql`variant.voters`,
            }
          : {
              gradeDelta: sql`variant.score - reference.grade_step`,
              voterCount: sql`variant.voters`,
            },
      )}
    FROM grouped_votes variant
    ${
      rating
        ? sql``
        : sql`
      ${currentReferenceGradeJoins()}
      JOIN vote_grade_scale reference ON reference.board_type = variant.board_type
        AND reference.difficulty = ${currentReferenceDifficultySql()}::int
    `
    }
  `;
}

/** The raw board/time scan is preflight-capped before any ancestry is walked. */
export function commentRankScores(scope: GymReportingScope, raw: SQL, eligibility: SQL): SQL {
  const author = identifiedActor(sql`discussion.user_id`, sql`activity.board_id`, scope.viewerId);
  return sql`
    WITH candidates AS MATERIALIZED (${raw})
    SELECT ${variantColumns}, min(activity.board_id) AS board_id,
      ${projections({ commentCount: sql`count(*)::int`, authorCount: sql`count(DISTINCT ${author})::int` })}
    FROM (
      SELECT context.comment_id, context.gym_id, context.logical_board_id AS board_id, scoped.physical_board_uuid,
        context.board_type, context.climb_uuid, context.angle, context.is_mirror
      FROM candidates context JOIN configurations scoped ON scoped.board_id = context.logical_board_id
        AND scoped.board_uuid = context.board_uuid
    ) activity
    JOIN comments discussion ON discussion.id = activity.comment_id AND discussion.deleted_at IS NULL
      AND discussion.entity_type = 'tick'
    JOIN boardsesh_ticks tick ON tick.uuid = discussion.entity_id AND tick.origin = 'native'
      AND tick.board_id = activity.board_id AND tick.reporting_board_id = tick.board_id
      AND tick.reporting_gym_id = activity.gym_id AND tick.reporting_attribution IN ('uuid', 'presence', 'session', 'edit')
      AND tick.board_type = activity.board_type AND tick.angle = activity.angle AND tick.is_mirror = activity.is_mirror
      AND tick.kilter_detached_at IS NULL
    LEFT JOIN board_climb_aliases alias ON alias.board_type = tick.board_type AND alias.alias_uuid = tick.climb_uuid
    ${eligibility}
      AND coalesce(alias.canonical_uuid, tick.climb_uuid) = activity.climb_uuid
      AND ${contentVisibilityCondition('tick', sql`tick.uuid`, sql`tick.user_id`, scope.viewerId)}
      AND NOT EXISTS (
        SELECT 1 FROM content_privacy policy WHERE policy.entity_type = 'tick' AND policy.entity_id = tick.uuid
          AND policy.audience = 'only_me'
      )
      AND ${reportingCommentAudience(scope.viewerId)}
    GROUP BY ${variantColumns}
  `;
}

export function quietRankScores(scope: GymReportingScope, oldestStart: string, intervals: SQL): SQL {
  const source = reportingActivitySql(scope, { start: oldestStart, end: scope.asOf, sendsOnly: true, ticksOnly: true });
  return sql`
    WITH measured_ranges AS MATERIALIZED (${intervals}),
    known AS (
      SELECT board_id, climb_uuid, angle, min(start_at) AS first_known,
        sum(extract(epoch FROM end_at - start_at)) AS lifetime_seconds,
        sum(greatest(0, extract(epoch FROM least(end_at, ${scope.asOf}::timestamptz)
          - greatest(start_at, ${scope.current.startAt}::timestamptz)))) AS window_seconds
      FROM measured_ranges GROUP BY board_id, climb_uuid, angle
      HAVING sum(extract(epoch FROM end_at - start_at)) >= 14 * 86400
    ),
    sends AS MATERIALIZED (
      SELECT activity.*, ${reportingActivityInWindowSql(scope.current)} AS in_window
      FROM (${source}) activity
      JOIN known ON known.board_id = activity.board_id AND known.climb_uuid = activity.climb_uuid AND known.angle = activity.angle
      WHERE activity.board_type = 'spray' AND activity.is_mirror IS FALSE
        AND EXISTS (SELECT 1 FROM measured_ranges measured WHERE measured.board_id = activity.board_id
          AND measured.climb_uuid = activity.climb_uuid AND measured.angle = activity.angle
          AND ((activity.precision = 'instant' AND activity.occurred_at >= measured.start_at AND activity.occurred_at < measured.end_at)
            OR (activity.precision = 'day' AND activity.possible_start_at >= measured.start_at
              AND activity.possible_end_at <= measured.end_at AND activity.possible_start_at < activity.possible_end_at)))
    ),
    window_sends AS (
      SELECT board_id, climb_uuid, angle, count(*) FILTER (WHERE in_window)::int AS sends
      FROM sends GROUP BY board_id, climb_uuid, angle
    ),
    last_sends AS (
      SELECT DISTINCT ON (board_id, climb_uuid, angle) board_id, climb_uuid, angle, occurred_at,
        possible_start_at, possible_end_at, CASE WHEN precision = 'day' THEN local_date END AS local_date
      FROM sends ORDER BY board_id, climb_uuid, angle, coalesce(possible_end_at, occurred_at) DESC,
        coalesce(possible_start_at, occurred_at) DESC, activity_id::bigint DESC
    )
    SELECT inventory.physical_board_uuid, inventory.board_type, inventory.climb_uuid,
      inventory.angle, false AS is_mirror, inventory.board_id,
      ${projections({
        sendCount: sql`coalesce(window_sends.sends, 0)`,
        firstKnownAvailableAt: utc(sql`known.first_known`),
        lastSendAt: utc(sql`coalesce(last_sends.occurred_at, last_sends.possible_start_at)`),
        lastSendEndAt: utc(sql`last_sends.possible_end_at`),
        lastSendDate: sql`last_sends.local_date::text`,
        knownLifetimeDays: sql`known.lifetime_seconds / 86400`,
        knownWindowDays: sql`known.window_seconds / 86400`,
        sendsPerDay: sql`coalesce(window_sends.sends, 0) * 86400 / known.window_seconds`,
      })}
    FROM inventory
    JOIN known USING (board_id, climb_uuid, angle)
    LEFT JOIN window_sends USING (board_id, climb_uuid, angle)
    LEFT JOIN last_sends USING (board_id, climb_uuid, angle)
    WHERE known.window_seconds > 0
  `;
}
