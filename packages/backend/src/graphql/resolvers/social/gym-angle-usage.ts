import { sql } from 'drizzle-orm';
import { getRecordedLedBoardAngles } from '@boardsesh/board-config';
import type { GymAngleActivityCounts, GymBoardAngleUsage } from '@boardsesh/shared-schema';
import type { GymReportingScope } from './gym-reporting';

type EligibleAngleBoard = {
  board_id: number;
  allowed_angles: readonly number[];
};

export type GymAngleBucket = GymAngleActivityCounts & {
  boardUuid: string;
  angle: number | null;
  isBoardTotal: boolean;
  distinctClimberCount: number;
  climberDayCount: number;
  unresolvedLocalDateTickCount: number;
};

export function scopedGymAngleBoards(scope: GymReportingScope) {
  const physicalBoardUuids = new Set<string>();
  const logicalBoards: EligibleAngleBoard[] = [];
  for (const board of scope.activityBoards) {
    if (!board.hasLeds) continue;
    const allowedAngles = getRecordedLedBoardAngles(board.boardType);
    if (!allowedAngles) continue;
    physicalBoardUuids.add(board.physicalBoardUuid);
    logicalBoards.push({ board_id: board.id, allowed_angles: allowedAngles });
  }

  return {
    physicalBoardUuids: scope.boards.filter(({ uuid }) => physicalBoardUuids.has(uuid)).map(({ uuid }) => uuid),
    logicalBoards,
  };
}

/** Read the existing authorized exact-window relation; no second source scan. */
export function gymAngleUsageCtes(logicalBoards: EligibleAngleBoard[]) {
  return sql`
    classified_angles AS (
      SELECT exact.physical_board_uuid, exact.actor_id, exact.local_date, exact.source, exact.status,
        CASE WHEN exact.angle = ANY(eligible.allowed_angles) THEN exact.angle END AS angle
      FROM exact
      JOIN jsonb_to_recordset(${JSON.stringify(logicalBoards)}::jsonb)
        AS eligible(board_id bigint, allowed_angles integer[]) ON eligible.board_id = exact.board_id
      WHERE exact.in_current
    ),
    angle_buckets AS (
      SELECT physical_board_uuid AS "boardUuid", angle,
        GROUPING(angle) = 1 AS "isBoardTotal",
        count(DISTINCT actor_id) FILTER (WHERE angle IS NOT NULL)::int AS "distinctClimberCount",
        count(DISTINCT (actor_id, local_date))
          FILTER (WHERE actor_id IS NOT NULL AND local_date IS NOT NULL)::int AS "climberDayCount",
        count(*) FILTER (WHERE source = 'tick' AND actor_id IS NOT NULL AND local_date IS NULL)::int
          AS "unresolvedLocalDateTickCount",
        count(*) FILTER (WHERE source = 'tick')::int AS "tickCount",
        count(*) FILTER (WHERE source = 'tick' AND status IN ('flash', 'send'))::int AS "sendCount",
        count(*) FILTER (WHERE source = 'display')::int AS "displayCount"
      FROM classified_angles
      GROUP BY GROUPING SETS ((physical_board_uuid, angle), (physical_board_uuid))
    )
  `;
}

export function assembleGymAngleUsage(physicalBoardUuids: string[], buckets: GymAngleBucket[]): GymBoardAngleUsage[] {
  const reports = new Map<string, GymBoardAngleUsage>(
    physicalBoardUuids.map((boardUuid) => [
      boardUuid,
      {
        boardUuid,
        knownAngleClimberCount: 0,
        angles: [],
        unknownAngle: { tickCount: 0, sendCount: 0, displayCount: 0 },
      },
    ]),
  );
  for (const bucket of buckets) {
    const report = reports.get(bucket.boardUuid);
    if (!report) continue;
    const {
      angle,
      distinctClimberCount,
      climberDayCount,
      unresolvedLocalDateTickCount,
      tickCount,
      sendCount,
      displayCount,
    } = bucket;
    const activity = { tickCount, sendCount, displayCount };
    if (bucket.isBoardTotal) {
      report.knownAngleClimberCount = distinctClimberCount;
    } else if (angle === null) {
      report.unknownAngle = activity;
    } else {
      report.angles.push({ angle, distinctClimberCount, climberDayCount, unresolvedLocalDateTickCount, ...activity });
    }
  }
  return [...reports.values()];
}
