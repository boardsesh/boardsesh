import { sql } from 'drizzle-orm';
import type { GraphQLResolveInfo } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import { ownedOrPublicClimbCondition } from '@boardsesh/db/queries';
import { selectedFieldNames } from '../shared/selected-fields';
import { activateGymReachObservation, readGymReachObservation } from './gym-reporting-observation';
import { readGymReachOverview } from './gym-reporting-overview';
import { readGymBusyTimes } from './gym-busy-times';
import type { ConnectionContext, GymDayActivity, GymStats, GymTopClimb } from '@boardsesh/shared-schema';
import {
  readGymReportingCoverage,
  reportingActivityInWindowSql,
  reportingActivitySql,
  withGymReportingScope,
  type GymReportingScope,
} from './gym-reporting';
import { assembleGymAngleUsage, gymAngleUsageCtes, scopedGymAngleBoards, type GymAngleBucket } from './gym-angle-usage';

type Snapshot = {
  currentUnique: number;
  currentAscents: number;
  currentTicks: number;
  currentDisplays: number;
  previousUnique: number;
  previousAscents: number;
  previousTicks: number;
  previousDisplays: number;
  topClimbs: GymTopClimb[];
  busiestDays: GymDayActivity[];
  angleBuckets: GymAngleBucket[];
};

export function gymStatsSnapshotSql(scope: GymReportingScope, angleBoards = scopedGymAngleBoards(scope)) {
  return sql`
    WITH activity AS (${reportingActivitySql(scope, { start: scope.previous.startAt, end: scope.asOf })}),
    exact AS (
      SELECT *, ${reportingActivityInWindowSql(scope.current)} AS in_current
      FROM activity
      WHERE ${reportingActivityInWindowSql(scope.current)} OR ${reportingActivityInWindowSql(scope.previous)}
    ),
    counts AS (
      SELECT count(DISTINCT actor_id) FILTER (WHERE in_current)::int AS "currentUnique",
        count(*) FILTER (WHERE in_current AND source = 'tick' AND status IN ('flash', 'send'))::int AS "currentAscents",
        count(*) FILTER (WHERE in_current AND source = 'tick')::int AS "currentTicks",
        count(*) FILTER (WHERE in_current AND source = 'display')::int AS "currentDisplays",
        count(DISTINCT actor_id) FILTER (WHERE NOT in_current)::int AS "previousUnique",
        count(*) FILTER (WHERE NOT in_current AND source = 'tick' AND status IN ('flash', 'send'))::int AS "previousAscents",
        count(*) FILTER (WHERE NOT in_current AND source = 'tick')::int AS "previousTicks",
        count(*) FILTER (WHERE NOT in_current AND source = 'display')::int AS "previousDisplays"
      FROM exact
    ),
    current_sends AS (
      SELECT * FROM exact WHERE in_current AND source = 'tick' AND status IN ('flash', 'send')
    ),
    top_counts AS (
      SELECT send.climb_uuid, send.board_type, send.angle, climb.name, count(*)::int AS ascent_count
      FROM current_sends send
      JOIN board_climbs climb ON climb.uuid = send.climb_uuid AND climb.board_type = send.board_type
      WHERE ${ownedOrPublicClimbCondition(
        {
          isDraft: sql`climb.is_draft`,
          isListed: sql`climb.is_listed`,
          userId: sql`climb.user_id`,
        },
        scope.viewerId,
      )}
      GROUP BY send.climb_uuid, send.board_type, send.angle, climb.name
      ORDER BY ascent_count DESC, send.climb_uuid, send.board_type, send.angle
      LIMIT 10
    ),
    top_climbs AS (
      SELECT top.climb_uuid AS "climbUuid", top.board_type AS "boardType", top.angle, top.name,
        grade.boulder_name AS "gradeName", top.ascent_count AS "ascentCount"
      FROM top_counts top
      LEFT JOIN board_climb_stats stats ON stats.climb_uuid = top.climb_uuid AND stats.board_type = top.board_type
        AND stats.angle = top.angle
      LEFT JOIN board_difficulty_grades grade ON grade.board_type = top.board_type
        AND grade.difficulty = ROUND(stats.display_difficulty)
    ),
    weekdays AS (
      SELECT EXTRACT(DOW FROM local_date)::int AS "dayOfWeek", count(*)::int AS "ascentCount"
      FROM current_sends WHERE local_date IS NOT NULL GROUP BY 1
    ),
    ${gymAngleUsageCtes(angleBoards.logicalBoards)}
    SELECT counts.*,
      COALESCE((SELECT json_agg(top_climbs ORDER BY "ascentCount" DESC, "climbUuid", "boardType", angle)
        FROM top_climbs), '[]'::json) AS "topClimbs",
      COALESCE((SELECT json_agg(weekdays ORDER BY "dayOfWeek") FROM weekdays), '[]'::json) AS "busiestDays",
      COALESCE((SELECT json_agg(angle_buckets ORDER BY angle) FROM angle_buckets), '[]'::json) AS "angleBuckets"
    FROM counts
  `;
}

export const socialGymInsightsQueries = {
  gymStats: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
    info?: GraphQLResolveInfo,
  ): Promise<GymStats> => {
    const fields = selectedFieldNames(info);
    const includeReach = fields?.has('reachOverview') ?? false;
    const includeBusyTimes = fields?.has('busyTimes') ?? false;
    const result = await withGymReportingScope(input, ctx, async (tx, scope) => {
      const angleBoards = scopedGymAngleBoards(scope);
      const [snapshot] = rowsFromResult<Snapshot>(await tx.execute(gymStatsSnapshotSql(scope, angleBoards)));
      const coverage = await readGymReportingCoverage(tx, scope);
      const observation = includeReach || includeBusyTimes ? await readGymReachObservation(tx, scope) : null;
      const reach = includeReach && observation ? await readGymReachOverview(tx, scope, observation.startedAt) : null;
      const busyTimes =
        includeBusyTimes && observation
          ? await readGymBusyTimes(tx, scope, observation.startedAt, reach?.hasUnboundedIdentifiedTime)
          : null;
      const stats: GymStats = {
        reachOverview: reach?.overview ?? null,
        busyTimes,
        gymUuid: scope.gym.uuid,
        gymName: scope.gym.name,
        boardUuid: scope.boardUuid,
        boards: scope.boards,
        canManageBoardAliases: scope.canManageBoardAliases,
        asOf: scope.asOf,
        timeZone: scope.timeZone,
        timeZoneConfigured: scope.timeZoneConfigured,
        periodDays: scope.periodDays,
        coverage,
        current: {
          ...scope.current,
          uniqueClimbers: snapshot.currentUnique,
          ascentCount: snapshot.currentAscents,
          displayCount: snapshot.currentDisplays,
          tickCount: snapshot.currentTicks,
        },
        previous: {
          ...scope.previous,
          uniqueClimbers: snapshot.previousUnique,
          ascentCount: snapshot.previousAscents,
          displayCount: snapshot.previousDisplays,
          tickCount: snapshot.previousTicks,
        },
        topClimbs: snapshot.topClimbs,
        busiestDays: snapshot.busiestDays,
        angleUsage: assembleGymAngleUsage(angleBoards.physicalBoardUuids, snapshot.angleBuckets),
      };
      return { stats, activate: observation?.needsActivation ? scope : null };
    });
    if (result.activate) await activateGymReachObservation(result.activate);
    return result.stats;
  },
};
